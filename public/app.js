'use strict';

/* Super Cleaners booking form — 5-step request flow.
   Nothing is ever "confirmed" here: submitting sends a REQUEST that John
   confirms personally. Card data never touches our server — the Square
   Web Payments SDK tokenizes in the browser when Square is configured. */

const state = {
  config: null,
  packages: [],
  sizeClasses: [],
  pkg: null,
  size: null,
  date: null,
  startMin: null,
  slots: [],
  square: { payments: null, card: null, attached: false },
};

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

function track(event, params) {
  // GA4 hooks (spec Phase 1): forwarded to gtag/dataLayer when present.
  try {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event }, params || {}));
    if (typeof window.gtag === 'function') window.gtag('event', event, params || {});
  } catch (_) {}
}

function money(n) {
  return n == null ? 'Custom quote' : '$' + n;
}

function priceFor(pkg, sizeId) {
  if (!pkg || pkg.inquiry) return 'Custom quote';
  const base = sizeId === 'suv' ? pkg.priceSuv : pkg.priceCar;
  return (pkg.pricePrefix || '') + money(base);
}

/* ---------------- init ---------------- */

async function init() {
  const [cfgRes, pkgRes] = await Promise.all([fetch('/api/config'), fetch('/api/packages')]);
  state.config = await cfgRes.json();
  const data = await pkgRes.json();
  state.packages = data.packages;
  state.sizeClasses = data.sizeClasses;
  renderPackages();
  const dateInput = $('#fDate');
  dateInput.min = state.config.todayLocal;
  dateInput.addEventListener('change', () => {
    state.date = dateInput.value || null;
    state.startMin = null;
    loadSlots();
  });
  wireSteps();
  wirePayment();
}

function renderPackages() {
  const list = $('#packageList');
  list.innerHTML = '';
  for (const pkg of state.packages) {
    const label = document.createElement('label');
    label.className = 'choice-card';
    const priceLine = pkg.inquiry
      ? 'Custom quote — premium service'
      : `${priceFor(pkg, 'car')} car · ${priceFor(pkg, 'suv')} SUV/Truck/Van`;
    label.innerHTML = `
      <input type="radio" name="packageId" value="${pkg.id}" />
      <span class="choice-title">${pkg.name}</span>
      <span class="choice-sub">${pkg.blurb}</span>
      <span class="choice-price">${priceLine}</span>`;
    label.querySelector('input').addEventListener('change', () => {
      state.pkg = pkg;
      state.startMin = null;
      $('#addonBox').hidden = !(pkg.addons && pkg.addons.length);
      updateSizePrices();
      track('select_package', { package_id: pkg.id });
    });
    list.appendChild(label);
  }
}

function updateSizePrices() {
  $$('[data-price-for]').forEach((el) => {
    el.textContent = state.pkg ? priceFor(state.pkg, el.getAttribute('data-price-for')) : '';
  });
}

/* ---------------- steps ---------------- */

let currentStep = 1;

function showStep(n) {
  currentStep = n;
  $$('.step').forEach((s) => {
    const isThis = Number(s.getAttribute('data-step')) === n;
    s.hidden = !isThis;
    s.classList.toggle('is-active', isThis);
  });
  $$('.progress-step').forEach((d) => {
    const dn = Number(d.getAttribute('data-dot'));
    d.classList.toggle('is-active', dn === n);
    d.classList.toggle('is-done', dn < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (n === 4) loadSlots();
  if (n === 5) renderSummary();
}

function stepError(stepEl, msg) {
  const box = $('[data-error]', stepEl);
  if (!box) return;
  if (msg) {
    box.textContent = msg;
    box.hidden = false;
  } else {
    box.hidden = true;
    box.textContent = '';
  }
}

function validateStep(n) {
  const stepEl = $(`.step[data-step="${n}"]`);
  stepError(stepEl, '');
  if (n === 1) {
    if (!state.pkg) return fail(stepEl, 'Please choose a service to continue.');
  }
  if (n === 2) {
    const picked = $('input[name="sizeClass"]:checked');
    if (!picked) return fail(stepEl, 'Please choose your vehicle size.');
    state.size = picked.value;
  }
  if (n === 3) {
    if ($('#fName').value.trim().length < 2) return fail(stepEl, 'Please enter your name.');
    const digits = $('#fPhone').value.replace(/\D/g, '');
    if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) {
      return fail(stepEl, 'Please enter a valid 10-digit mobile number.');
    }
    if ($('#fAddress').value.trim().length < 8) return fail(stepEl, 'Please enter the service address.');
    if (!/^\d{5}(-\d{4})?$/.test($('#fZip').value.trim())) return fail(stepEl, 'Please enter a valid ZIP code.');
    if (!$('#fVehMake').value.trim() || !$('#fVehModel').value.trim()) {
      return fail(stepEl, 'Please enter your vehicle make and model.');
    }
  }
  if (n === 4) {
    if (!state.date) return fail(stepEl, 'Please pick a date.');
    if (state.startMin == null) return fail(stepEl, 'Please pick a start time.');
  }
  return true;
}

function fail(stepEl, msg) {
  stepError(stepEl, msg);
  return false;
}

function wireSteps() {
  $$('[data-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (validateStep(currentStep)) {
        if (currentStep === 2) track('select_size', { size_class: state.size });
        showStep(currentStep + 1);
      }
    });
  });
  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => showStep(currentStep - 1));
  });
  $$('input[name="sizeClass"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.size = r.value;
      state.startMin = null;
    });
  });
  $('#bookingForm').addEventListener('submit', onSubmit);
}

/* ---------------- availability ---------------- */

async function loadSlots() {
  const grid = $('#slotGrid');
  if (!state.date || !state.pkg) {
    grid.innerHTML = '<p class="hint">Choose a date to see open start times.</p>';
    return;
  }
  grid.innerHTML = '<p class="hint">Checking open times…</p>';
  try {
    const res = await fetch(`/api/availability?date=${encodeURIComponent(state.date)}&package=${encodeURIComponent(state.pkg.id)}`);
    const data = await res.json();
    if (!res.ok) {
      grid.innerHTML = `<p class="hint">${data.error || 'Could not load times.'}</p>`;
      return;
    }
    state.slots = data.slots;
    grid.innerHTML = '';
    const available = data.slots.filter((s) => s.available);
    if (!available.length) {
      grid.innerHTML = '<p class="hint">No open start times that day for this service — try another date, or call us and we will find a way.</p>';
      return;
    }
    for (const slot of data.slots) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot' + (state.startMin === slot.startMin ? ' is-selected' : '');
      b.textContent = slot.label;
      b.disabled = !slot.available;
      b.addEventListener('click', () => {
        state.startMin = slot.startMin;
        $$('.slot', grid).forEach((x) => x.classList.remove('is-selected'));
        b.classList.add('is-selected');
      });
      grid.appendChild(b);
    }
  } catch (e) {
    grid.innerHTML = '<p class="hint">Could not load times — please call (661) 376-5857 and we will book you by phone.</p>';
  }
}

/* ---------------- payment / Square ---------------- */

function isFirstTime() {
  const picked = $('input[name="firstTime"]:checked');
  return !picked || picked.value === 'yes';
}

function wirePayment() {
  $$('input[name="paymentMethod"]').forEach((r) => {
    r.addEventListener('change', () => updateCardBox());
  });
}

async function updateCardBox() {
  const method = ($('input[name="paymentMethod"]:checked') || {}).value;
  const box = $('#cardBox');
  if (method !== 'card') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const first = isFirstTime();
  $('#cardExplain').textContent = first
    ? 'First visit with us? We save a card on file — no charge today, we only charge after your detail is done.'
    : 'Welcome back! Saving a card is optional for returning customers — no charge today either way, we charge after your detail.';
  $('#cardOptInRow').hidden = first;
  if (!first) $('#cardSaveOptIn').checked = false;

  const sq = state.config && state.config.square;
  if (sq && sq.enabled) {
    $('#squareAltNote').hidden = true;
    await attachSquareCard();
  } else {
    $('#squareAltNote').hidden = false;
  }
}

function loadSquareSdk(environment) {
  return new Promise((resolve, reject) => {
    if (window.Square) return resolve();
    const s = document.createElement('script');
    s.src =
      environment === 'production'
        ? 'https://web.squarecdn.com/v1/square.js'
        : 'https://sandbox.web.squarecdn.com/v1/square.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function attachSquareCard() {
  if (state.square.attached) return;
  const sq = state.config.square;
  try {
    await loadSquareSdk(sq.environment);
    const payments = window.Square.payments(sq.applicationId, sq.locationId);
    const card = await payments.card();
    await card.attach('#squareCardMount');
    state.square = { payments, card, attached: true };
  } catch (e) {
    console.error('Square attach failed', e);
    $('#squareAltNote').hidden = false;
  }
}

/* ---------------- summary + submit ---------------- */

function selectedAddons() {
  const ids = [];
  if (state.pkg && state.pkg.addons && $('#addonSunroof').checked) ids.push('sunroof');
  return ids;
}

function estimatedPrice() {
  if (!state.pkg || state.pkg.inquiry) return null;
  let price = state.size === 'suv' ? state.pkg.priceSuv : state.pkg.priceCar;
  if (selectedAddons().includes('sunroof')) price += 75;
  return price;
}

function renderSummary() {
  const box = $('#summaryBox');
  if (!state.pkg) {
    box.innerHTML = '';
    return;
  }
  const slot = state.slots.find((s) => s.startMin === state.startMin);
  const price = estimatedPrice();
  const dateText = state.date
    ? new Date(state.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : '';
  box.innerHTML = `
    <div class="sum-title">Your request</div>
    <div class="sum-row"><span>Service</span><strong>${state.pkg.name}</strong></div>
    <div class="sum-row"><span>Vehicle size</span><strong>${state.size === 'suv' ? 'SUV / Truck / Van' : 'Car'}</strong></div>
    <div class="sum-row"><span>When</span><strong>${dateText}${slot ? ' · ' + slot.label : ''}</strong></div>
    <div class="sum-row"><span>Estimated price</span><strong>${price == null ? 'Custom quote' : (state.pkg.pricePrefix || '') + money(price)}</strong></div>`;
}

async function onSubmit(e) {
  e.preventDefault();
  const stepEl = $('.step[data-step="5"]');
  stepError(stepEl, '');
  const method = ($('input[name="paymentMethod"]:checked') || {}).value;
  if (!method) return fail(stepEl, 'Please choose how you will pay after your detail.');
  if (!$('#termsAgreed').checked) {
    return fail(stepEl, 'Please agree to the Privacy Policy and Terms so we can take your request.');
  }

  const submitBtn = $('#submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';

  try {
    // Tokenize the card when Square is live and a card is being saved:
    // required for first-time card payers, opt-in for returning customers.
    let cardSourceId = null;
    const sqOn = state.config.square && state.config.square.enabled && state.square.attached;
    const mustTokenize = method === 'card' && sqOn && (isFirstTime() || $('#cardSaveOptIn').checked);
    if (mustTokenize) {
      const result = await state.square.card.tokenize();
      if (result.status !== 'OK') {
        const msg = (result.errors && result.errors[0] && result.errors[0].message) || 'That card could not be verified.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send my request';
        return fail(stepEl, msg + ' Please check the card details and try again.');
      }
      cardSourceId = result.token;
    }

    const payload = {
      packageId: state.pkg.id,
      sizeClass: state.size,
      addonIds: selectedAddons(),
      name: $('#fName').value.trim(),
      phone: $('#fPhone').value.trim(),
      email: $('#fEmail').value.trim(),
      address: $('#fAddress').value.trim(),
      zip: $('#fZip').value.trim(),
      vehicleYear: $('#fVehYear').value.trim(),
      vehicleMake: $('#fVehMake').value.trim(),
      vehicleModel: $('#fVehModel').value.trim(),
      notes: $('#fNotes').value.trim(),
      firstTime: isFirstTime(),
      date: state.date,
      startMin: state.startMin,
      paymentMethod: method,
      cardSourceId,
      cardSaveOptIn: $('#cardSaveOptIn').checked,
      consentTransactional: $('#consentTransactional').checked,
      consentMarketing: $('#consentMarketing').checked,
      termsAgreed: $('#termsAgreed').checked,
    };

    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send my request';
      return fail(stepEl, (data.errors || ['Something went wrong.']).join(' '));
    }

    track('submit_request', { package_id: state.pkg.id, payment_method: method });
    $('#bookingForm').hidden = true;
    $('#progress').hidden = true;
    const panel = $('#successPanel');
    panel.hidden = false;
    $('#successRef').textContent = data.requestId ? `Reference: ${data.requestId}` : '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send my request';
    return fail(stepEl, 'Connection trouble — please try again, or call (661) 376-5857 and we will take your request by phone.');
  }
}

document.addEventListener('DOMContentLoaded', init);
