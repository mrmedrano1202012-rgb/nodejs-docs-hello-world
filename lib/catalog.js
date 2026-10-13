'use strict';

/**
 * Service catalog — single source of truth for menu, prices and durations.
 * Prices EXACTLY per spec / live menu. `priceCar` / `priceSuv` are null for
 * inquiry services (custom quote). Durations drive the availability engine:
 * a slot must fit entirely inside the 7 AM–7 PM booking window.
 */

const SIZE_CLASSES = [
  { id: 'car', label: 'Car' },
  { id: 'suv', label: 'SUV / Truck / Van' },
];

const PACKAGES = [
  {
    id: 'maintenance',
    name: 'Maintenance Wash',
    blurb: 'Foam wash, wheels & tires, interior vacuum + wipe-down, windows in/out, door jambs.',
    priceCar: 65,
    priceSuv: 75,
    pricePrefix: '',
    durationMin: 60,
    inquiry: false,
  },
  {
    id: 'complete',
    name: 'Complete Detail',
    blurb: 'Full inside-and-out detail — our most popular reset for daily drivers.',
    priceCar: 149,
    priceSuv: 179,
    pricePrefix: '',
    durationMin: 150,
    inquiry: false,
  },
  {
    id: 'deep-interior',
    name: 'Deep Interior Detail',
    blurb: 'Deep extraction clean of seats and carpets, full interior restoration.',
    priceCar: 299,
    priceSuv: 350,
    pricePrefix: '',
    durationMin: 240,
    inquiry: false,
  },
  {
    id: 'ultimate',
    name: 'Ultimate Detail',
    blurb: 'The works — full detail, machine polish and premium protection.',
    priceCar: 549,
    priceSuv: 599,
    pricePrefix: 'from ',
    durationMin: 360,
    inquiry: false,
  },
  {
    id: 'paint-decon',
    name: 'Paint Decon & Sealant',
    blurb: 'Clay-bar decontamination plus a durable paint sealant.',
    priceCar: 200,
    priceSuv: 220,
    pricePrefix: '',
    durationMin: 180,
    inquiry: false,
  },
  {
    id: 'headliner',
    name: 'Headliner Replacement',
    blurb: 'Full headliner re-fabric. Sunroof / panoramic roof adds $75.',
    priceCar: 349,
    priceSuv: 449,
    pricePrefix: '',
    durationMin: 240,
    inquiry: false,
    addons: [
      { id: 'sunroof', name: 'Sunroof / panoramic roof', price: 75 },
    ],
  },
  {
    id: 'ceramic-inquiry',
    name: 'Ceramic Coating — Inquiry',
    blurb: 'Premium long-term protection. Tell us about your vehicle and we will quote it personally — no obligation.',
    priceCar: null,
    priceSuv: null,
    pricePrefix: '',
    durationMin: 60,
    inquiry: true,
  },
  {
    id: 'paint-correction-inquiry',
    name: 'Paint Correction — Inquiry',
    blurb: 'Swirl and scratch removal. Tell us about your vehicle and we will quote it personally — no obligation.',
    priceCar: null,
    priceSuv: null,
    pricePrefix: '',
    durationMin: 60,
    inquiry: true,
  },
];

function getPackage(id) {
  return PACKAGES.find((p) => p.id === id) || null;
}

function getSizeClass(id) {
  return SIZE_CLASSES.find((s) => s.id === id) || null;
}

/** Estimated price for a package + size (+ selected add-on ids). Null for inquiries. */
function estimatePrice(pkg, sizeId, addonIds) {
  if (!pkg || pkg.inquiry) return null;
  let price = sizeId === 'suv' ? pkg.priceSuv : pkg.priceCar;
  if (Array.isArray(pkg.addons) && Array.isArray(addonIds)) {
    for (const addon of pkg.addons) {
      if (addonIds.includes(addon.id)) price += addon.price;
    }
  }
  return price;
}

module.exports = { PACKAGES, SIZE_CLASSES, getPackage, getSizeClass, estimatePrice };
