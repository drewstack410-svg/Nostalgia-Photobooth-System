// Mock payment middleware — for testing the PULL integration before the
// client's real server is reachable.
//
//   node scripts/mock-payment-middleware.js
//
// Then run the app with:
//   PAYMENT_API_URL=http://127.0.0.1:8080 npm run electron:dev
//
// It implements the DEFAULT contract the kiosk expects, so if the real
// middleware matches this shape, zero configuration is needed:
//
//   POST /payments/intents          -> { "id": "...", "status": "pending" }
//   GET  /payments/intents/{id}     -> { "id": "...", "status": "pending"|"paid" }
//   POST /payments/intents/{id}/cancel -> { "status": "cancelled" }
//
// By default an intent flips to "paid" PAY_AFTER_MS after creation, so
// you can watch the kiosk advance on its own. Set PAY_AFTER_MS=0 to keep
// it pending and mark it paid by hand:
//   curl -X POST http://127.0.0.1:8080/pay/<id>

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.MOCK_PORT || 8080);
const PAY_AFTER_MS = Number(process.env.PAY_AFTER_MS ?? 6000);

const intents = new Map();
let seq = 0;

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = u.pathname;
    console.log(`[mock] ${req.method} ${req.url}`);

    if (req.method === 'POST' && p === '/payments/intents') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch (_) {}
        const id = `mock_${++seq}`;
        intents.set(id, { id, status: 'pending', ...payload });
        console.log(`[mock]   created ${id} amount=${payload.amount} template=${payload.templateId}`);
        if (PAY_AFTER_MS > 0) {
          setTimeout(() => {
            const it = intents.get(id);
            if (it && it.status === 'pending') {
              it.status = 'paid';
              console.log(`[mock]   ${id} -> paid`);
            }
          }, PAY_AFTER_MS);
        }
        send(res, 201, { id, status: 'pending', qrUrl: null });
      });
      return;
    }

    let m = p.match(/^\/payments\/intents\/([^/]+)\/cancel$/);
    if (m) {
      const it = intents.get(m[1]);
      if (it) it.status = 'cancelled';
      console.log(`[mock]   ${m[1]} -> cancelled`);
      return send(res, 200, { id: m[1], status: 'cancelled' });
    }

    m = p.match(/^\/payments\/intents\/([^/]+)$/);
    if (m) {
      const it = intents.get(m[1]);
      if (!it) return send(res, 404, { error: 'not found' });
      return send(res, 200, { id: it.id, status: it.status });
    }

    // Manual override: POST /pay/<id>
    m = p.match(/^\/pay\/([^/]+)$/);
    if (m) {
      const it = intents.get(m[1]);
      if (!it) return send(res, 404, { error: 'not found' });
      it.status = 'paid';
      console.log(`[mock]   ${m[1]} -> paid (manual)`);
      return send(res, 200, { id: it.id, status: 'paid' });
    }

    send(res, 404, { error: 'unknown endpoint' });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[mock] payment middleware on http://127.0.0.1:${PORT}`);
    console.log(
      PAY_AFTER_MS > 0
        ? `[mock] intents auto-pay after ${PAY_AFTER_MS}ms`
        : '[mock] intents stay pending — POST /pay/<id> to complete',
    );
  });
