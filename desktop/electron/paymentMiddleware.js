// ───────────────────────────────────────────────────────────────────
// PAYMENT MIDDLEWARE API CLIENT  (replaces the physical bill acceptor)
// ───────────────────────────────────────────────────────────────────
// The client has built their own payment middleware. This module is the
// kiosk half of that integration.
//
// THERE ARE TWO WAYS TO CONNECT. Both are supported; pick whichever
// matches what the middleware can do.
//
//   A. PUSH  (middleware calls us)  — nothing to configure, works today.
//        The middleware POSTs/GETs our local endpoint when a sale
//        completes. See `/api/payment` in electron/main.js. This is the
//        simplest option and needs no outbound network at all.
//
//   B. PULL  (we call the middleware) — this module.
//        On entering the Payment screen we ask the middleware to start a
//        sale, then poll it until it reports paid. Use this when the
//        middleware cannot reach back into the app, or when we need a
//        transaction id / QR image from it.
//
// WHY THE MAIN PROCESS: the renderer's Content-Security-Policy allows
// connect-src only to 'self' + Cloudinary, so a fetch() from Vue to any
// middleware host is blocked outright. Outbound HTTP must live here.
//
// EVERYTHING IS CONFIG-DRIVEN. We do not know the middleware's exact
// endpoint paths, field names or status vocabulary yet, so all of it is
// env-configurable (see .env.example). Adapting to their real contract
// should be editing environment variables, not editing this file.
//
// This module is INERT unless PAYMENT_API_URL is set — the existing
// LumaBooth localhost:1500 path keeps working untouched.

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ── Config ─────────────────────────────────────────────────────────
function cfg() {
  const e = process.env;
  const list = (v, d) =>
    String(v || d)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return {
    baseUrl: e.PAYMENT_API_URL || '',
    apiKey: e.PAYMENT_API_KEY || '',
    authHeader: e.PAYMENT_API_AUTH_HEADER || 'Authorization',
    authScheme: e.PAYMENT_API_AUTH_SCHEME === '' ? '' : e.PAYMENT_API_AUTH_SCHEME || 'Bearer',
    createPath: e.PAYMENT_CREATE_PATH || '/payments/intents',
    statusPath: e.PAYMENT_STATUS_PATH || '/payments/intents/{id}',
    cancelPath: e.PAYMENT_CANCEL_PATH || '/payments/intents/{id}/cancel',
    createMethod: (e.PAYMENT_CREATE_METHOD || 'POST').toUpperCase(),
    pollMs: Number(e.PAYMENT_POLL_MS || 2000),
    timeoutMs: Number(e.PAYMENT_TIMEOUT_MS || 180000),
    // Response field names + status vocabulary
    idField: e.PAYMENT_ID_FIELD || 'id',
    statusField: e.PAYMENT_STATUS_FIELD || 'status',
    paidValues: list(e.PAYMENT_PAID_VALUES, 'paid,succeeded,completed,success,captured'),
    failedValues: list(
      e.PAYMENT_FAILED_VALUES,
      'failed,expired,cancelled,canceled,voided,declined',
    ),
    qrFields: list(e.PAYMENT_QR_FIELD, 'qrImage,qrUrl,qr_code_url,qr'),
    amountMinorUnits: String(e.PAYMENT_AMOUNT_MINOR_UNITS || 'false') === 'true',
    kioskId: e.KIOSK_ID || e.VITE_KIOSK_ID || 'booth-1',
    currency: e.PAYMENT_CURRENCY || 'PHP',
  };
}

function isEnabled() {
  return !!cfg().baseUrl;
}

// ── Tiny JSON HTTP helper (no new dependencies) ────────────────────
function request(method, url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error(`Bad PAYMENT_API_URL / path: ${url}`));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: Object.assign(
          { Accept: 'application/json' },
          payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {},
          headers || {},
        ),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (_) {
            /* non-JSON response; keep raw */
          }
          resolve({ status: res.statusCode, json, raw: data });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || 15000, () => {
      req.destroy(new Error('middleware request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Walks a dotted path ("data.attributes.status") and is case-tolerant. */
function pick(obj, field) {
  if (!obj || !field) return undefined;
  let cur = obj;
  for (const part of String(field).split('.')) {
    if (cur == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(cur, part)) {
      cur = cur[part];
      continue;
    }
    const key = Object.keys(cur).find((k) => k.toLowerCase() === part.toLowerCase());
    cur = key ? cur[key] : undefined;
  }
  return cur;
}

/** Finds the id/status/QR even if it is nested under data/result/payment. */
function deepPick(json, field) {
  const direct = pick(json, field);
  if (direct !== undefined) return direct;
  for (const wrap of ['data', 'result', 'payment', 'intent', 'transaction']) {
    const v = pick(json, `${wrap}.${field}`);
    if (v !== undefined) return v;
  }
  return undefined;
}

// ── Session state ──────────────────────────────────────────────────
let active = null; // { intentId, timer, startedAt, amount, templateId }

function authHeaders(c) {
  if (!c.apiKey) return {};
  const value = c.authScheme ? `${c.authScheme} ${c.apiKey}` : c.apiKey;
  return { [c.authHeader]: value };
}

function urlFor(c, path, id) {
  const p = String(path).replace('{id}', encodeURIComponent(id == null ? '' : id));
  return c.baseUrl.replace(/\/+$/, '') + (p.startsWith('/') ? p : `/${p}`);
}

function stop(reason) {
  if (active && active.timer) clearInterval(active.timer);
  if (active) console.log(`[PayAPI] session ended (${reason}) intent=${active.intentId}`);
  active = null;
}

/**
 * Ask the middleware to start a sale, then poll until it says paid.
 * `emitCredit` is main.js's emitPaymentCredit — the SAME seam the
 * LumaBooth path uses, so the renderer and payment store need no
 * changes whatsoever.
 */
async function beginSession({ amount, templateId }, emitCredit) {
  const c = cfg();
  if (!c.baseUrl) return { success: false, disabled: true };
  stop('superseded');

  const amountToSend = c.amountMinorUnits ? Math.round(Number(amount) * 100) : Number(amount);
  const body = {
    kioskId: c.kioskId,
    amount: amountToSend,
    currency: c.currency,
    templateId: templateId || null,
    reference: `${c.kioskId}-${Date.now()}`,
  };

  console.log(`[PayAPI] create intent → ${urlFor(c, c.createPath)} ${JSON.stringify(body)}`);
  let res;
  try {
    res = await request(
      c.createMethod,
      urlFor(c, c.createPath),
      c.createMethod === 'GET' ? null : body,
      Object.assign(authHeaders(c), { 'Idempotency-Key': body.reference }),
    );
  } catch (err) {
    console.error('[PayAPI] create intent failed:', err.message);
    emitCredit({ error: `Payment service unreachable: ${err.message}` });
    return { success: false, error: err.message };
  }

  if (!res.status || res.status >= 300) {
    console.error(`[PayAPI] create intent HTTP ${res.status}: ${res.raw?.slice(0, 300)}`);
    emitCredit({ error: `Payment service error (HTTP ${res.status})` });
    return { success: false, error: `HTTP ${res.status}` };
  }

  const intentId = deepPick(res.json, c.idField);
  if (!intentId) {
    console.error(
      `[PayAPI] no "${c.idField}" in create response — set PAYMENT_ID_FIELD. Body: ${res.raw?.slice(0, 300)}`,
    );
    emitCredit({ error: 'Payment service returned no transaction id' });
    return { success: false, error: 'missing id' };
  }

  let qr = null;
  for (const f of c.qrFields) {
    const v = deepPick(res.json, f);
    if (v) {
      qr = v;
      break;
    }
  }

  active = { intentId, startedAt: Date.now(), amount, templateId, timer: null };
  console.log(`[PayAPI] intent ${intentId} created; polling every ${c.pollMs}ms`);

  active.timer = setInterval(() => {
    void poll(emitCredit);
  }, c.pollMs);

  return { success: true, intentId, qr };
}

async function poll(emitCredit) {
  if (!active) return;
  const c = cfg();
  const id = active.intentId;

  if (Date.now() - active.startedAt > c.timeoutMs) {
    console.warn(`[PayAPI] intent ${id} timed out after ${c.timeoutMs}ms`);
    emitCredit({ error: 'Payment timed out. Please try again.' });
    stop('timeout');
    return;
  }

  let res;
  try {
    res = await request('GET', urlFor(c, c.statusPath, id), null, authHeaders(c));
  } catch (err) {
    // Transient network blips must not kill the sale — keep polling
    // until the timeout above decides.
    console.warn('[PayAPI] status poll failed (will retry):', err.message);
    return;
  }
  if (!res.status || res.status >= 300) {
    console.warn(`[PayAPI] status HTTP ${res.status} (will retry)`);
    return;
  }

  const raw = deepPick(res.json, c.statusField);
  const status = String(raw == null ? '' : raw).toLowerCase();
  if (!status) {
    console.warn(
      `[PayAPI] no "${c.statusField}" in status response — set PAYMENT_STATUS_FIELD. Body: ${res.raw?.slice(0, 200)}`,
    );
    return;
  }

  if (c.paidValues.includes(status)) {
    console.log(`[PayAPI] ✓ intent ${id} PAID — crediting session`);
    emitCredit({ paidInFull: true, source: 'middleware-api', transactionId: id });
    stop('paid');
    return;
  }
  if (c.failedValues.includes(status)) {
    console.warn(`[PayAPI] intent ${id} ${status}`);
    emitCredit({ error: `Payment ${status}. Please try again.` });
    stop(status);
    return;
  }
  // Anything else (pending/awaiting_payment/processing) → keep waiting.
}

async function cancelSession(reason) {
  const c = cfg();
  if (!active) return { success: true, noop: true };
  const id = active.intentId;
  stop(reason || 'cancelled');
  if (!c.cancelPath) return { success: true };
  try {
    await request('POST', urlFor(c, c.cancelPath, id), {}, authHeaders(c));
    console.log(`[PayAPI] cancelled intent ${id}`);
  } catch (err) {
    // Best-effort: the guest already walked away.
    console.warn('[PayAPI] cancel failed (ignored):', err.message);
  }
  return { success: true };
}

module.exports = { isEnabled, beginSession, cancelSession, cfg };
