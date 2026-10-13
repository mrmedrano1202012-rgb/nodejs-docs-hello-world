'use strict';

/**
 * Square card-on-file (server side).
 *
 * PCI rule from the spec: card data NEVER touches this server. The browser
 * tokenizes with the Square Web Payments SDK and sends only a one-time
 * source token; here we create/find the Square customer and attach the
 * card via the Cards API. No charge is made — charging happens after the
 * detail, in Square, by John.
 *
 * Env-gated: requires SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID. When not
 * configured (or when no token was supplied), returns a skipped status and
 * the booking still succeeds — John sends the card-save link manually.
 */

const https = require('https');
const crypto = require('crypto');
const config = require('./config');

function squareBase() {
  return config.square.environment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

function squarePost(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      `${squareBase()}${pathname}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.square.accessToken}`,
          'Content-Type': 'application/json',
          'Square-Version': '2024-09-19',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_) {
            /* leave null */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else
            reject(
              new Error(
                `Square ${pathname} HTTP ${res.statusCode}: ${JSON.stringify(
                  (json && json.errors) || data.slice(0, 200)
                )}`
              )
            );
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Attach a tokenized card to a Square customer profile.
 * Returns { status: 'saved'|'skipped'|'failed', squareCustomerId?, cardId?, error? }
 */
async function saveCardOnFile({ sourceId, customer, appointmentLabel }) {
  if (!config.squareServerEnabled) {
    return { status: 'skipped', reason: 'square-not-configured' };
  }
  if (!sourceId) {
    return { status: 'skipped', reason: 'no-card-token' };
  }
  try {
    const names = String(customer.name || '').trim().split(/\s+/);
    const custRes = await squarePost('/v2/customers', {
      idempotency_key: crypto.randomUUID(),
      given_name: names[0] || 'Customer',
      family_name: names.slice(1).join(' ') || undefined,
      phone_number: customer.phone,
      email_address: customer.email || undefined,
      address: { address_line_1: customer.address },
      reference_id: `sc-booking-${Date.now()}`,
      note: appointmentLabel || undefined,
    });
    const squareCustomerId = custRes.customer && custRes.customer.id;

    const cardRes = await squarePost('/v2/cards', {
      idempotency_key: crypto.randomUUID(),
      source_id: sourceId,
      card: { customer_id: squareCustomerId },
    });
    return {
      status: 'saved',
      squareCustomerId,
      cardId: cardRes.card && cardRes.card.id,
    };
  } catch (e) {
    console.error('[square] card-on-file failed:', e.message);
    return { status: 'failed', error: e.message };
  }
}

module.exports = { saveCardOnFile };
