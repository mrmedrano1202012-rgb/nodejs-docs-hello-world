'use strict';

/**
 * Notify-John hook + customer message templates.
 *
 * On every booking request John gets the full details instantly:
 *  - Email via SMTP (env-gated: SMTP_HOST / SMTP_USER / NOTIFY_EMAIL_TO)
 *  - SMS via Twilio REST (env-gated: TWILIO_* + JOHN_NOTIFY_PHONE)
 * When credentials are absent, the would-be notification is logged to the
 * server console instead — the booking is never blocked by notification.
 *
 * Every outbound SMS template includes STOP language (spec compliance).
 */

const https = require('https');
const config = require('./config');
const store = require('./store');

function priceText(price) {
  return price == null ? 'Custom quote (inquiry)' : `$${price}`;
}

function paymentText(b) {
  const map = {
    card: 'Card on file',
    venmo: 'Venmo (after detail)',
    zelle: 'Zelle (after detail)',
    cash: 'Cash (after detail)',
  };
  let t = map[b.appointment.paymentMethod] || b.appointment.paymentMethod;
  if (b.appointment.paymentMethod !== 'card') t += ' — CASH-EQUIV PAYER';
  return t;
}

function buildJohnMessage(b) {
  const lines = [
    `NEW BOOKING REQUEST — Super Cleaners`,
    `When: ${b.appointment.whenLabel}`,
    `Package: ${b.appointment.packageName} (${b.vehicle.sizeLabel}) — ${priceText(b.appointment.priceEstimate)}`,
    `Customer: ${b.customer.name}${b.appointment.isRepeatCustomer ? ' (repeat)' : ' (NEW)'}`,
    `Phone: ${b.customer.phone}`,
    b.customer.email ? `Email: ${b.customer.email}` : null,
    `Address: ${b.customer.address}`,
    `Vehicle: ${[b.vehicle.year, b.vehicle.make, b.vehicle.model].filter(Boolean).join(' ')}`,
    b.appointment.addons && b.appointment.addons.length
      ? `Add-ons: ${b.appointment.addons.join(', ')}`
      : null,
    `Payment: ${paymentText(b)}`,
    `Card on file: ${b.appointment.cardOnFileStatus}`,
    `Text consent: transactional=${b.consent.transactional ? 'yes' : 'NO'}, marketing=${b.consent.marketing ? 'yes' : 'no'}`,
    b.customer.notes ? `Notes: ${b.customer.notes}` : null,
    b.appointment.slotNote ? `Heads-up: ${b.appointment.slotNote}` : null,
    `Request ID: ${b.id || '(pending)'}`,
    `Next: create the Square appointment, then send the confirmation text.`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * The confirmation text John sends the customer after creating the Square
 * appointment (he sends it personally — the system never auto-confirms).
 * Included in John's notification email so he can copy/paste it.
 */
function buildCustomerConfirmationText(b) {
  return (
    `Hi ${String(b.customer.name || '').split(' ')[0]}, this is John with Super Cleaners Detailing. ` +
    `You're all set for ${b.appointment.whenLabel} — ${b.appointment.packageName}, ${priceText(b.appointment.priceEstimate)}, ` +
    `at ${b.customer.address}. We come to you. Reply YES to confirm, or reply here if anything changes. ` +
    `Reply STOP to opt out.`
  );
}

async function sendEmail(subject, text) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });
  await transporter.sendMail({
    from: config.smtp.from || config.smtp.user,
    to: config.smtp.to,
    subject,
    text,
  });
}

function sendTwilioSms(to, body) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams({
      To: to,
      From: config.twilio.fromNumber,
      Body: body,
    }).toString();
    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const req = https.request(
      `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`Twilio HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Fire John notifications; never throws. Returns a per-channel status map. */
async function notifyJohn(booking) {
  const subject = `New booking request — ${booking.appointment.packageName}, ${booking.appointment.whenLabel}`;
  const body = buildJohnMessage(booking);
  const emailBody =
    body + `\n\n--- Suggested confirmation text for the customer ---\n${buildCustomerConfirmationText(booking)}\n`;
  const result = { email: 'disabled', sms: 'disabled' };

  if (config.emailEnabled) {
    try {
      await sendEmail(subject, emailBody);
      result.email = 'sent';
    } catch (e) {
      console.error('[notify] email failed:', e.message);
      result.email = 'failed';
    }
  } else {
    console.log('[notify] EMAIL DISABLED (SMTP env not set). Would-be notification:\n' + emailBody);
  }

  if (config.smsEnabled) {
    try {
      await sendTwilioSms(config.twilio.johnPhone, body);
      result.sms = 'sent';
    } catch (e) {
      console.error('[notify] SMS failed:', e.message);
      result.sms = 'failed';
    }
  } else {
    console.log('[notify] SMS DISABLED (Twilio env not set). Would-be SMS:\n' + body);
  }

  store.logMessage(booking.id, 'email', 'request', result.email).catch(() => {});
  store.logMessage(booking.id, 'sms', 'request', result.sms).catch(() => {});
  return result;
}

module.exports = { notifyJohn, buildJohnMessage, buildCustomerConfirmationText };
