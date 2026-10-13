'use strict';

/**
 * Central configuration — everything comes from environment variables.
 * No secrets or credentials are ever hard-coded. When a group of env vars
 * is absent, the related feature is disabled (env-gated) and the app
 * falls back to a safe dev behavior (JSON store, logged notifications).
 */

function bool(v) {
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  timezone: process.env.BUSINESS_TIMEZONE || 'America/Los_Angeles',
  businessPhoneDisplay: process.env.BUSINESS_PHONE_DISPLAY || '(661) 376-5857',
  businessPhoneDigits: process.env.BUSINESS_PHONE_DIGITS || '6613765857',

  // Booking window (local business time). After-hours is phone-only.
  openHour: 7,   // 7 AM
  closeHour: 19, // 7 PM — a job must END by this hour
  slotStepMin: 30,
  minLeadMinutes: parseInt(process.env.MIN_LEAD_MINUTES, 10) || 120, // 2h lead time
  maxAdvanceDays: parseInt(process.env.MAX_ADVANCE_DAYS, 10) || 60,

  // Storage: MySQL when DB_* present, else local JSON file.
  db: {
    host: process.env.DB_HOST || '',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
  },
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),

  // Availability provider: Google Calendar free/busy when configured.
  google: {
    calendarId: process.env.GOOGLE_CALENDAR_ID || '',
    // Full service-account JSON (raw or base64) OR email+key pair below.
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || '',
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
  // Dev fallback busy blocks: JSON array of {"start": ISO, "end": ISO}.
  devBusyJson: process.env.DEV_BUSY_JSON || '',

  // Square (Web Payments SDK on the client + Cards API on the server).
  square: {
    applicationId: process.env.SQUARE_APPLICATION_ID || '',
    locationId: process.env.SQUARE_LOCATION_ID || '',
    accessToken: process.env.SQUARE_ACCESS_TOKEN || '',
    environment: (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase(),
  },

  // Notify John — email via SMTP.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: bool(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASS || '',
    from: process.env.NOTIFY_EMAIL_FROM || '',
    to: process.env.NOTIFY_EMAIL_TO || '',
  },

  // Notify John — SMS via Twilio.
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    johnPhone: process.env.JOHN_NOTIFY_PHONE || '',
  },
};

config.dbEnabled = Boolean(config.db.host && config.db.user && config.db.database);
config.googleEnabled = Boolean(
  config.google.calendarId &&
    (config.google.serviceAccountJson || (config.google.clientEmail && config.google.privateKey))
);
config.squareClientEnabled = Boolean(config.square.applicationId && config.square.locationId);
config.squareServerEnabled = Boolean(config.square.accessToken && config.square.locationId);
config.emailEnabled = Boolean(config.smtp.host && config.smtp.user && config.smtp.to);
config.smsEnabled = Boolean(
  config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber && config.twilio.johnPhone
);

module.exports = config;
