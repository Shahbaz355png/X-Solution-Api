// X Solution API — Official WhatsApp Business Cloud API server
//
// Uses Meta's official API: no QR needed, no ban risk from unofficial
// clients. The phone number is connected once in the Meta dashboard.
//
// Endpoints:
//   GET  /webhook                 Meta webhook verification
//   POST /webhook                 incoming messages + delivery statuses
//   POST /api/send-text           { to, message }
//   POST /api/send-media          { to, media_type: image|document|video|audio, url, caption, filename }
//   POST /api/send-template       { to, template, language, params[] }
//   POST /api/broadcast           { recipients: [...], kind: text|media|template, ...same fields }
//   GET  /api/broadcast/:job_id   progress of a bulk job
//   GET  /api/health              config check
//
// All /api/* routes need header:  x-api-key: <API_KEY>

const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-me-in-production';
const WABA_TOKEN = process.env.WHATSAPP_TOKEN;       // permanent system-user token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // from Meta dashboard
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'xsolution-verify';
const GRAPH = 'https://graph.facebook.com/v21.0';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function guard(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'bad api key' });
  next();
}

const digits = (n) => String(n || '').replace(/\D/g, '');

async function waPost(path, body) {
  if (!WABA_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('WHATSAPP_TOKEN / PHONE_NUMBER_ID not set — see README');
  }
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WABA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Meta API ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// ---------- Meta webhook verification ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ---------- incoming messages / statuses ----------
app.post('/webhook', (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    if (entry?.messages) {
      for (const m of entry.messages) {
        console.log('INCOMING', m.from, ':', (m.text?.body || m.type || '').slice(0, 120));
      }
    }
    if (entry?.statuses) {
      for (const s of entry.statuses) {
        console.log('STATUS', s.id, '->', s.status);
      }
    }
  } catch (e) { /* never crash the webhook */ }
  res.sendStatus(200);
});

// ---------- single text ----------
app.post('/api/send-text', guard, async (req, res) => {
  try {
    const { to, message, preview_url } = req.body || {};
    if (!to || !message) return res.status(400).json({ ok: false, error: 'to and message are required' });
    const data = await waPost('/messages', {
      messaging_product: 'whatsapp',
      to: digits(to),
      type: 'text',
      text: { body: String(message).slice(0, 4096), preview_url: !!preview_url },
    });
    res.json({ ok: true, id: data.messages[0].id });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ---------- single media (image / document / video / audio) ----------
app.post('/api/send-media', guard, async (req, res) => {
  try {
    const { to, media_type = 'image', url, caption = '', filename } = req.body || {};
    if (!to || !url) return res.status(400).json({ ok: false, error: 'to and url are required' });
    if (!['image', 'document', 'video', 'audio'].includes(media_type)) {
      return res.status(400).json({ ok: false, error: 'media_type must be image|document|video|audio' });
    }
    const media = { link: url };
    if (caption && media_type !== 'audio') media.caption = String(caption).slice(0, 1024);
    if (filename && media_type === 'document') media.filename = filename;
    const data = await waPost('/messages', {
      messaging_product: 'whatsapp',
      to: digits(to),
      type: media_type,
      [media_type]: media,
    });
    res.json({ ok: true, id: data.messages[0].id });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ---------- template (required for bulk / marketing outside 24h window) ----------
app.post('/api/send-template', guard, async (req, res) => {
  try {
    const { to, template, language = 'en', params = [] } = req.body || {};
    if (!to || !template) return res.status(400).json({ ok: false, error: 'to and template are required' });
    const data = await waPost('/messages', {
      messaging_product: 'whatsapp',
      to: digits(to),
      type: 'template',
      template: {
        name: template,
        language: { code: language },
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }],
      },
    });
    res.json({ ok: true, id: data.messages[0].id });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ---------- bulk sending (queued, ~1 msg/sec, with progress) ----------
const jobs = {};
let jobSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendOne(to, kind, rest) {
  if (kind === 'media') {
    const { media_type = 'image', url, caption = '', filename } = rest;
    const media = { link: url };
    if (caption && media_type !== 'audio') media.caption = String(caption).slice(0, 1024);
    if (filename && media_type === 'document') media.filename = filename;
    return waPost('/messages', { messaging_product: 'whatsapp', to, type: media_type, [media_type]: media });
  }
  if (kind === 'template') {
    const { template, language = 'en', params = [] } = rest;
    return waPost('/messages', {
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: template, language: { code: language },
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] },
    });
  }
  const { message } = rest;
  return waPost('/messages', {
    messaging_product: 'whatsapp', to, type: 'text', text: { body: String(message).slice(0, 4096) },
  });
}

app.post('/api/broadcast', guard, async (req, res) => {
  const { recipients = [], kind = 'text', ...rest } = req.body || {};
  const list = [...new Set(recipients.map(digits).filter(Boolean))];
  if (!list.length) return res.status(400).json({ ok: false, error: 'recipients[] is required' });
  if (kind === 'text' && !rest.message) return res.status(400).json({ ok: false, error: 'message is required for kind=text' });
  if (kind === 'media' && !rest.url) return res.status(400).json({ ok: false, error: 'url is required for kind=media' });
  if (kind === 'template' && !rest.template) return res.status(400).json({ ok: false, error: 'template is required for kind=template' });

  const id = 'job_' + ++jobSeq + '_' + Date.now().toString(36);
  jobs[id] = { id, kind, total: list.length, sent: 0, failed: 0, status: 'running', errors: [] };
  res.json({ ok: true, job_id: id, total: list.length });

  (async () => {
    for (const to of list) {
      if (jobs[id].status !== 'running') break;
      try { await sendOne(to, kind, rest); jobs[id].sent++; }
      catch (e) {
        jobs[id].failed++;
        if (jobs[id].errors.length < 10) jobs[id].errors.push({ to, error: String(e.message || e).slice(0, 120) });
      }
      await sleep(1100 + Math.random() * 800); // gentle pace — respects Meta rate limits
    }
    jobs[id].status = 'done';
    console.log(`broadcast ${id} done: ${jobs[id].sent} sent, ${jobs[id].failed} failed`);
  })();
});

app.get('/api/broadcast/:id', guard, (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ ok: false, error: 'unknown job id' });
  res.json({ ok: true, job: j });
});

// ---------- health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: 'official-cloud-api', phone_number_id: PHONE_NUMBER_ID ? 'set' : 'MISSING', token: WABA_TOKEN ? 'set' : 'MISSING' });
});

app.get('/', (req, res) => res.send('X Solution API — official WhatsApp Cloud API server. See /api/health'));

app.listen(PORT, () => console.log(`X Solution API (official) listening on :${PORT}`));
