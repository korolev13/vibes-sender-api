'use strict';

const express = require('express');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));

function env(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

const PORT = Number(env('PORT', '3000'));
const SMTP_HOST = env('SMTP_HOST', 'smtp.yandex.ru');
const SMTP_PORT = Number(env('SMTP_PORT', '465'));
const SMTP_SECURE = env('SMTP_SECURE', 'true').toLowerCase() !== 'false';
const SMTP_USER = env('SMTP_USER');
const SMTP_PASSWORD = env('SMTP_PASSWORD');
const FROM_NAME = env('FROM_NAME', 'VIBES Video Lab');
const REPLY_TO = env('REPLY_TO', SMTP_USER);
const MESSAGE_ID_DOMAIN = env('MESSAGE_ID_DOMAIN', (SMTP_USER.split('@')[1] || 'vibesvideolab.space'));
const API_KEY = env('API_KEY');
const MAX_REQUESTS_PER_MINUTE = Math.max(1, Number(env('MAX_REQUESTS_PER_MINUTE', '120')) || 120);

const referencePath = path.join(__dirname, 'reference.png');

function requireConfig() {
  const missing = [];
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
  if (!API_KEY) missing.push('API_KEY');
  if (!fs.existsSync(referencePath)) missing.push('reference.png');
  if (missing.length) {
    throw new Error('Missing required configuration: ' + missing.join(', '));
  }
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASSWORD
  },
  pool: true,
  maxConnections: 2,
  maxMessages: 50,
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000
});

function bearerToken(req) {
  const raw = String(req.headers.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function auth(req, res, next) {
  if (!API_KEY || !timingSafeEqualString(bearerToken(req), API_KEY)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// Lightweight in-memory rate guard. Persistent rate limits will be added in Multi-Sender V2.
let rateWindowStart = Date.now();
let rateWindowCount = 0;
function rateGuard(req, res, next) {
  const now = Date.now();
  if (now - rateWindowStart >= 60000) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  if (rateWindowCount > MAX_REQUESTS_PER_MINUTE) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }
  next();
}

function cleanHeader(value, maxLen = 500) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function validEmail(value) {
  const s = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function makeMessageId() {
  return `<vibes-${Date.now()}-${crypto.randomUUID()}@${MESSAGE_ID_DOMAIN}>`;
}

// Best-effort idempotency inside one running Railway instance.
// V2 will move this to persistent storage so it survives redeploys/restarts.
const idempotency = new Map();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
function pruneIdempotency() {
  const now = Date.now();
  for (const [key, entry] of idempotency.entries()) {
    if (!entry || now - entry.ts > IDEMPOTENCY_TTL_MS) idempotency.delete(key);
  }
  if (idempotency.size > 5000) {
    const keys = Array.from(idempotency.keys()).slice(0, idempotency.size - 5000);
    keys.forEach(k => idempotency.delete(k));
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'VIBES Sender API',
    version: VERSION,
    transport: 'direct SMTP',
    referenceReady: fs.existsSync(referencePath)
  });
});

app.get('/smtp-health', auth, rateGuard, async (req, res) => {
  try {
    requireConfig();
    await transporter.verify();
    res.json({
      ok: true,
      smtp: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      user: SMTP_USER
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: 'smtp_verify_failed',
      message: cleanHeader(error && error.message ? error.message : error, 1000)
    });
  }
});

app.post('/send', auth, rateGuard, async (req, res) => {
  try {
    requireConfig();
    pruneIdempotency();

    const body = req.body || {};
    const to = cleanHeader(body.to, 320);
    const subject = cleanHeader(body.subject, 998);
    const html = String(body.html || '');
    const text = String(body.text || 'VIBES Video Lab');
    const requestId = cleanHeader(body.requestId || req.headers['x-idempotency-key'] || '', 200);
    const requestedMessageId = cleanHeader(body.messageId || '', 500);

    if (!validEmail(to)) {
      return res.status(400).json({ ok: false, error: 'invalid_to' });
    }
    if (!subject) {
      return res.status(400).json({ ok: false, error: 'missing_subject' });
    }
    if (!html) {
      return res.status(400).json({ ok: false, error: 'missing_html' });
    }

    if (requestId && idempotency.has(requestId)) {
      const previous = idempotency.get(requestId).response;
      return res.status(200).json({ ...previous, duplicate: true });
    }

    const messageId = requestedMessageId && /^<[^<>\s]+@[^<>\s]+>$/.test(requestedMessageId)
      ? requestedMessageId
      : makeMessageId();

    const info = await transporter.sendMail({
      from: { name: FROM_NAME, address: SMTP_USER },
      to,
      replyTo: REPLY_TO || SMTP_USER,
      subject,
      text,
      html,
      messageId,
      attachments: [
        {
          filename: 'reference.png',
          path: referencePath,
          cid: 'reference',
          contentDisposition: 'inline'
        }
      ],
      headers: {
        'X-VIBES-Sender': 'VIBES-Sender-API/1.0',
        ...(requestId ? { 'X-VIBES-Request-ID': requestId } : {})
      }
    });

    const response = {
      ok: true,
      sender: SMTP_USER,
      to,
      subject,
      messageId: info.messageId || messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      smtpResponse: cleanHeader(info.response || '', 1000),
      requestId: requestId || null
    };

    if (requestId) {
      idempotency.set(requestId, { ts: Date.now(), response });
    }

    res.status(200).json(response);
  } catch (error) {
    const smtpCode = error && (error.responseCode || error.code) ? String(error.responseCode || error.code) : '';
    res.status(502).json({
      ok: false,
      error: 'send_failed',
      smtpCode,
      message: cleanHeader(error && error.message ? error.message : error, 1500)
    });
  }
});

app.post('/test', auth, rateGuard, async (req, res) => {
  try {
    requireConfig();
    const to = cleanHeader((req.body || {}).to || SMTP_USER, 320);
    if (!validEmail(to)) return res.status(400).json({ ok: false, error: 'invalid_to' });

    const info = await transporter.sendMail({
      from: { name: FROM_NAME, address: SMTP_USER },
      to,
      replyTo: REPLY_TO || SMTP_USER,
      subject: 'VIBES Sender API · SMTP test',
      text: 'VIBES Sender API works. This test was sent directly through Yandex SMTP.',
      html: '<div style="font-family:Arial,sans-serif"><h2>VIBES Sender API</h2><p>Direct Yandex SMTP test is working.</p><img src="cid:reference" style="max-width:700px;width:100%;height:auto"></div>',
      messageId: makeMessageId(),
      attachments: [{ filename: 'reference.png', path: referencePath, cid: 'reference', contentDisposition: 'inline' }]
    });

    res.json({
      ok: true,
      sender: SMTP_USER,
      to,
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      smtpResponse: cleanHeader(info.response || '', 1000)
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: 'test_failed',
      message: cleanHeader(error && error.message ? error.message : error, 1500)
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

app.use((error, req, res, next) => {
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'payload_too_large' });
  }
  res.status(500).json({ ok: false, error: 'internal_error' });
});

try {
  requireConfig();
} catch (error) {
  console.warn('[VIBES Sender] Startup configuration warning:', error.message);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[VIBES Sender] v${VERSION} listening on port ${PORT}`);
});
