'use strict';

/**
 * Super Cleaners Detailing — owned booking request system (Phase 1).
 *
 * Customers submit a booking REQUEST through a 5-step mobile-first form.
 * Nothing is ever auto-confirmed: John reviews each request, creates the
 * Square appointment himself, and sends the confirmation text personally.
 *
 * Routes:
 *   GET  /                  booking form (public/index.html)
 *   GET  /api/config        public client config (Square on/off, phone)
 *   GET  /api/packages      service catalog
 *   GET  /api/availability  ?date=YYYY-MM-DD&package=<id> -> slots 7AM-7PM
 *   POST /api/bookings      submit a booking request
 *   GET  /health            liveness probe
 */

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const config = require('./lib/config');
const catalog = require('./lib/catalog');
const availability = require('./lib/availability');
const store = require('./lib/store');
const square = require('./lib/square');
const notify = require('./lib/notify');
const { minutesLabel, prettyDate, dateStrInTz, zonedTimeToUtc } = require('./lib/time');

const app = express();
app.disable('x-powered-by');
app.use(bodyParser.json({ limit: '64kb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    store: store.backend.kind,
    availabilityProvider: availability.getProvider().name,
    squareClient: config.squareClientEnabled,
    squareServer: config.squareServerEnabled,
    emailNotify: config.emailEnabled,
    smsNotify: config.smsEnabled,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    businessPhoneDisplay: config.businessPhoneDisplay,
    businessPhoneDigits: config.businessPhoneDigits,
    timezone: config.timezone,
    todayLocal: dateStrInTz(new Date(), config.timezone),
    square: {
      enabled: config.squareClientEnabled,
      applicationId: config.squareClientEnabled ? config.square.applicationId : null,
      locationId: config.squareClientEnabled ? config.square.locationId : null,
      environment: config.square.environment,
    },
  });
});

app.get('/api/packages', (req, res) => {
  res.json({ packages: catalog.PACKAGES, sizeClasses: catalog.SIZE_CLASSES });
});

app.get('/api/availability', async (req, res) => {
  const date = String(req.query.date || '');
  const pkg = catalog.getPackage(String(req.query.package || ''));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
  }
  if (!pkg) return res.status(400).json({ error: 'Unknown package.' });

  // Range guards: not in the past, not beyond the advance window.
  const today = dateStrInTz(new Date(), config.timezone);
  if (date < today) return res.status(400).json({ error: 'That date has passed.' });
  const maxDate = dateStrInTz(
    new Date(Date.now() + config.maxAdvanceDays * 86400000),
    config.timezone
  );
  if (date > maxDate) {
    return res.status(400).json({ error: `We book up to ${config.maxAdvanceDays} days out — please call ${config.businessPhoneDisplay} for later dates.` });
  }

  try {
    const result = await availability.getSlots(date, pkg.durationMin);
    res.json({ ...result, dateLabel: prettyDate(date, config.timezone), durationMin: pkg.durationMin });
  } catch (e) {
    console.error('[api] availability failed:', e.message);
    res.status(502).json({ error: 'Availability is unavailable right now — please call ' + config.businessPhoneDisplay + '.' });
  }
});

/* ---------------- submit ---------------- */

function cleanStr(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 300);
}

function normalizePhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+1' + digits.slice(1);
  if (digits.length === 10) return '+1' + digits;
  return null;
}

app.post('/api/bookings', async (req, res) => {
  const b = req.body || {};
  const errors = [];

  const pkg = catalog.getPackage(cleanStr(b.packageId, 60));
  if (!pkg) errors.push('Please choose a service.');
  const size = catalog.getSizeClass(cleanStr(b.sizeClass, 24));
  if (!size) errors.push('Please choose your vehicle size.');

  const name = cleanStr(b.name, 160);
  if (name.length < 2) errors.push('Please enter your name.');
  const phone = normalizePhone(b.phone);
  if (!phone) errors.push('Please enter a valid 10-digit mobile number.');
  const email = cleanStr(b.email, 190);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('That email looks incomplete.');
  const address = cleanStr(b.address, 255);
  if (address.length < 8) errors.push('Please enter the service address.');
  const zip = cleanStr(b.zip, 10);
  if (!/^\d{5}(-\d{4})?$/.test(zip)) errors.push('Please enter a valid ZIP code.');
  const outOfAreaZip = !/^(932|933|935)/.test(zip); // Kern County prefixes — flag, never block

  const vehicle = {
    year: cleanStr(b.vehicleYear, 8),
    make: cleanStr(b.vehicleMake, 80),
    model: cleanStr(b.vehicleModel, 80),
  };
  if (!vehicle.make || !vehicle.model) errors.push('Please enter your vehicle (make and model).');
  const notes = cleanStr(b.notes, 1000);

  const date = cleanStr(b.date, 10);
  const startMin = Number(b.startMin);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('Please pick a date.');
  if (!Number.isInteger(startMin)) errors.push('Please pick a start time.');

  const paymentMethod = cleanStr(b.paymentMethod, 16);
  if (!['card', 'venmo', 'zelle', 'cash'].includes(paymentMethod)) {
    errors.push('Please choose how you will pay after your detail.');
  }
  const declaredFirstTime = b.firstTime === true || b.firstTime === 'true' || b.firstTime === 'yes';
  const cardSourceId = cleanStr(b.cardSourceId, 200) || null;
  const cardSaveOptIn = b.cardSaveOptIn === true || b.cardSaveOptIn === 'true';

  // SMS consent + terms (spec compliance): agreement is required; the two
  // messaging consents are separate, explicit, and never pre-checked.
  const consent = {
    transactional: b.consentTransactional === true || b.consentTransactional === 'true',
    marketing: b.consentMarketing === true || b.consentMarketing === 'true',
    termsAgreed: b.termsAgreed === true || b.termsAgreed === 'true',
  };
  if (!consent.termsAgreed) errors.push('Please agree to the Privacy Policy and Terms to submit.');

  // Add-ons (headliner sunroof).
  const addonIds = Array.isArray(b.addonIds) ? b.addonIds.map((a) => cleanStr(a, 40)) : [];
  const addonNames = [];
  if (pkg && Array.isArray(pkg.addons)) {
    for (const addon of pkg.addons) if (addonIds.includes(addon.id)) addonNames.push(addon.name);
  }

  // Time-window validation: slot must fit 7 AM–7 PM on a valid in-range date.
  let startISO = null;
  let endISO = null;
  let whenLabel = '';
  if (pkg && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isInteger(startMin)) {
    const endMin = startMin + pkg.durationMin;
    if (startMin < config.openHour * 60 || endMin > config.closeHour * 60) {
      errors.push('Bookings run 7:00 AM–7:00 PM. For after-hours, please call us — a $50 emergency call-out fee applies and a card on file is required.');
    } else {
      const today = dateStrInTz(new Date(), config.timezone);
      if (date < today) errors.push('That date has passed.');
      startISO = zonedTimeToUtc(date, startMin, config.timezone).toISOString();
      endISO = zonedTimeToUtc(date, endMin, config.timezone).toISOString();
      if (new Date(startISO).getTime() < Date.now() + config.minLeadMinutes * 60000) {
        errors.push('Please pick a time at least 2 hours from now.');
      }
      whenLabel = `${prettyDate(date, config.timezone)} at ${minutesLabel(startMin)}`;
    }
  }

  if (errors.length) return res.status(400).json({ ok: false, errors });

  try {
    // Repeat detection (server-side, by phone) refines the customer's answer.
    const existing = await store.findCustomerByPhone(phone);
    const isRepeatCustomer = Boolean(existing);
    // Server record wins; with no record on file the customer is treated
    // as first-time (card-storage policy applies to card payers).
    const isFirstTime = !isRepeatCustomer;

    // Slot re-check (best effort — John eyeballs before confirming anyway).
    let slotNote = '';
    const stillFree = await availability.isFree(startISO, endISO);
    if (!stillFree) {
      slotNote = 'Requested slot may have just been taken — customer was told the request is in; please offer the nearest open time when you confirm.';
    }
    if (outOfAreaZip) {
      slotNote = (slotNote + ' ZIP is outside the usual Kern County service area — confirm travel when you call.').trim();
    }

    // Card on file (Square) — only when the customer chose card payment.
    let cardResult = { status: 'not-applicable' };
    if (paymentMethod === 'card') {
      const wantsCardSaved = isFirstTime || cardSaveOptIn || Boolean(cardSourceId);
      if (isFirstTime && !cardSourceId && config.squareServerEnabled) {
        // First-time card payer: storage is required by policy. The client
        // enforces tokenization when Square is configured; if we still get
        // no token, accept the request but flag it so John sends the
        // card-save link with his confirmation.
        cardResult = { status: 'required-missing-token' };
      } else if (wantsCardSaved) {
        cardResult = await square.saveCardOnFile({
          sourceId: cardSourceId,
          customer: { name, phone, email, address },
          appointmentLabel: `${pkg.name} — ${whenLabel}`,
        });
      } else {
        cardResult = { status: 'declined-by-repeat-customer' };
      }
    }
    const cardOnFile = cardResult.status === 'saved';

    const booking = {
      customer: { name, phone, email, address: `${address}, ${zip}`, notes },
      vehicle: { ...vehicle, sizeClass: size.id, sizeLabel: size.label },
      appointment: {
        packageId: pkg.id,
        packageName: pkg.name,
        priceEstimate: catalog.estimatePrice(pkg, size.id, addonIds),
        pricePrefix: pkg.pricePrefix || '',
        inquiry: pkg.inquiry,
        scheduledAt: startISO,
        endsAt: endISO,
        durationMin: pkg.durationMin,
        whenLabel,
        addons: addonNames,
        paymentMethod,
        isRepeatCustomer,
        cardOnFile,
        cardOnFileStatus: cardResult.status,
        slotNote,
        status: 'requested',
      },
      consent,
      source: 'web',
      submittedAt: new Date().toISOString(),
    };

    const saved = await store.saveBooking(booking);
    booking.id = saved.id;

    const notifyResult = await notify.notifyJohn(booking);

    // Customer-facing copy: a REQUEST was received — never "confirmed".
    res.status(201).json({
      ok: true,
      requestId: saved.id,
      message:
        'Request received — John confirms every booking personally, watch for a text shortly.',
      notify: notifyResult,
    });
  } catch (e) {
    console.error('[api] booking submit failed:', e);
    res.status(500).json({
      ok: false,
      errors: [`Something went wrong saving your request. Please call ${config.businessPhoneDisplay} and we will take care of you.`],
    });
  }
});

// SPA fallback for the root page (static middleware already serves it).
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.port, () => {
  console.log(`Super Cleaners booking app listening on port ${config.port}`);
  console.log(
    `store=${store.backend.kind} availability=${availability.getProvider().name} ` +
      `squareClient=${config.squareClientEnabled} squareServer=${config.squareServerEnabled} ` +
      `emailNotify=${config.emailEnabled} smsNotify=${config.smsEnabled}`
  );
  if (typeof store.probe === 'function') store.probe();
});
