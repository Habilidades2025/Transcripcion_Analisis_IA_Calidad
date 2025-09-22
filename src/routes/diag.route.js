import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;
import OpenAI from 'openai';

const router = express.Router();

router.get('/diagnostics/openai', async (_req, res) => {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 1 });
    const models = await client.models.list();
    res.json({ ok: true, count: models.data.length, sample: models.data.slice(0, 5).map(m => m.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: {
      name: err?.name, message: err?.message, status: err?.status, code: err?.code, type: err?.type
    }});
  }
});

router.get('/diagnostics/chat', async (_req, res) => {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 1 });
    const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
    const r = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Responde SOLO con "ok".' },
        { role: 'user', content: 'Di ok.' }
      ]
    });
    res.json({ ok: true, text: r.choices?.[0]?.message?.content || '' });
  } catch (err) {
    res.status(500).json({ ok: false, error: {
      name: err?.name, message: err?.message, status: err?.status, code: err?.code, type: err?.type
    }});
  }
});

router.get('/diagnostics/fw', async (_req, res) => {
  try {
    let base = (process.env.FW_SERVER_URL || 'http://127.0.0.1:8000/transcribe')
                .trim()
                .replace('localhost', '127.0.0.1');
    const health = base.replace('/transcribe', '/health');
    const r = await fetch(health);
    const j = await r.json();
    res.json({ ok: true, url: health, status: r.status, body: j });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
