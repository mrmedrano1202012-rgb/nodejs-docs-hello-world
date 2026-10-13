'use strict';

/**
 * Persistence.
 *
 * If DB_HOST / DB_USER / DB_NAME env vars are present, records go to MySQL
 * using the spec data model (customers / vehicles / appointments /
 * message_log). Otherwise records are appended to a local JSON file
 * (DATA_DIR, default ./data/bookings.json) so the app runs in dev with
 * zero credentials. The active backend is chosen once at startup; if the
 * MySQL connection fails at first use, the store falls back to JSON and
 * logs loudly rather than losing a booking request.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const backend = { kind: config.dbEnabled ? 'mysql' : 'json', pool: null, mysqlFailed: false };

function jsonFile() {
  return path.join(config.dataDir, 'bookings.json');
}

function readJsonRecords() {
  try {
    const file = jsonFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[store] could not read JSON store:', e.message);
    return [];
  }
}

function appendJsonRecord(record) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const records = readJsonRecords();
  records.push(record);
  fs.writeFileSync(jsonFile(), JSON.stringify(records, null, 2));
}

async function mysqlPool() {
  if (backend.pool) return backend.pool;
  const mysql = require('mysql2/promise');
  backend.pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: 4,
  });
  const pool = backend.pool;
  await pool.query(`CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    phone VARCHAR(32) NOT NULL UNIQUE,
    email VARCHAR(190) NULL,
    address VARCHAR(255) NULL,
    created_at DATETIME NOT NULL,
    notes TEXT NULL,
    referral_source VARCHAR(120) NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS vehicles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    year VARCHAR(8) NULL,
    make VARCHAR(80) NULL,
    model VARCHAR(80) NULL,
    size_class VARCHAR(24) NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS appointments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    vehicle_id INT NULL,
    package VARCHAR(60) NOT NULL,
    price DECIMAL(10,2) NULL,
    scheduled_at DATETIME NOT NULL,
    duration_min INT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'requested',
    square_appointment_id VARCHAR(80) NULL,
    card_on_file TINYINT(1) NOT NULL DEFAULT 0,
    source VARCHAR(40) NOT NULL DEFAULT 'web'
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS message_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id INT NULL,
    channel VARCHAR(16) NOT NULL,
    type VARCHAR(24) NOT NULL,
    sent_at DATETIME NOT NULL,
    status VARCHAR(24) NOT NULL
  )`);
  return pool;
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Has this phone number booked before? Drives the repeat/first-time logic. */
async function findCustomerByPhone(phone) {
  if (backend.kind === 'mysql' && !backend.mysqlFailed) {
    try {
      const pool = await mysqlPool();
      const [rows] = await pool.query('SELECT * FROM customers WHERE phone = ? LIMIT 1', [phone]);
      return rows[0] || null;
    } catch (e) {
      console.error('[store] MySQL lookup failed, falling back to JSON store:', e.message);
      backend.mysqlFailed = true;
    }
  }
  const records = readJsonRecords();
  const hit = records.find((r) => r.customer && r.customer.phone === phone);
  return hit ? hit.customer : null;
}

/**
 * Save a booking request. Returns { id, backend }.
 * `booking` is the normalized record built by the submit route.
 */
async function saveBooking(booking) {
  if (backend.kind === 'mysql' && !backend.mysqlFailed) {
    try {
      const pool = await mysqlPool();
      const c = booking.customer;
      const [cust] = await pool.query(
        `INSERT INTO customers (name, phone, email, address, created_at, notes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email), address = VALUES(address)`,
        [c.name, c.phone, c.email || null, c.address, nowSql(), c.notes || null]
      );
      let customerId = cust.insertId;
      if (!customerId) {
        const [rows] = await pool.query('SELECT id FROM customers WHERE phone = ?', [c.phone]);
        customerId = rows[0].id;
      }
      const v = booking.vehicle;
      const [veh] = await pool.query(
        'INSERT INTO vehicles (customer_id, year, make, model, size_class) VALUES (?, ?, ?, ?, ?)',
        [customerId, v.year || null, v.make || null, v.model || null, v.sizeClass || null]
      );
      const a = booking.appointment;
      const [appt] = await pool.query(
        `INSERT INTO appointments
           (customer_id, vehicle_id, package, price, scheduled_at, duration_min, status, card_on_file, source)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, 'web')`,
        [
          customerId,
          veh.insertId,
          a.packageId,
          a.priceEstimate,
          a.scheduledAt.replace('T', ' ').slice(0, 19),
          a.durationMin,
          a.cardOnFile ? 1 : 0,
        ]
      );
      return { id: String(appt.insertId), backend: 'mysql' };
    } catch (e) {
      console.error('[store] MySQL save failed, falling back to JSON store:', e.message);
      backend.mysqlFailed = true;
    }
  }
  const id = `req_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  appendJsonRecord({ id, savedAt: new Date().toISOString(), ...booking });
  return { id, backend: 'json' };
}

/** Log an outbound message (notification / confirmation) against an appointment. */
async function logMessage(appointmentId, channel, type, status) {
  if (backend.kind === 'mysql' && !backend.mysqlFailed) {
    try {
      const pool = await mysqlPool();
      await pool.query(
        'INSERT INTO message_log (appointment_id, channel, type, sent_at, status) VALUES (?, ?, ?, ?, ?)',
        [Number(appointmentId) || null, channel, type, nowSql(), status]
      );
      return;
    } catch (e) {
      console.error('[store] message_log insert failed:', e.message);
    }
  }
  console.log(
    `[message_log] appointment=${appointmentId} channel=${channel} type=${type} status=${status}`
  );
}

module.exports = { findCustomerByPhone, saveBooking, logMessage, backend };
