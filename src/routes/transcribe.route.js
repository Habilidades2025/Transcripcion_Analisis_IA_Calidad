// src/routes/transcribe.route.js
import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;

import multerPkg from 'multer';
const multer = multerPkg.default ?? multerPkg;

import Archiver from 'archiver';
import path from 'path';

import { transcribeAudio } from '../services/transcriptionService.js';

const router = express.Router();

// Memoria; 100MB por archivo (ajusta si lo necesitas)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.BATCH_MAX_FILE_SIZE || 100 * 1024 * 1024) }
});

// ---------- Helpers ----------
function toPlainTranscript(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'object') {
    if (typeof t.text === 'string') return t.text;
    if (Array.isArray(t.segments)) {
      try { return t.segments.map(s => (s?.text || '').trim()).filter(Boolean).join('\n'); } catch {}
    }
  }
  try { return JSON.stringify(t); } catch { return String(t); }
}
function baseTxtName(original) {
  const base = (original || 'audio').replace(/\.[a-z0-9]+$/i, '');
  const safe = base.replace(/[^a-z0-9._-]+/gi, '_');
  return safe || 'audio';
}
function pickOptsFromBody(body) {
  const language     = (body?.language || 'es-ES').trim();
  const provider     = (body?.provider || '').toString().trim().toLowerCase(); // 'faster' | 'openai' | ''
  const mode         = (body?.mode || '').toString().trim().toLowerCase();     // 'mono' | 'stereo' | ''
  const agentChannel = Number.isFinite(Number(body?.agentChannel)) ? Number(body.agentChannel) : undefined;

  const allowed = new Set(['faster', 'openai', '']);
  if (!allowed.has(provider)) {
    const err = new Error(`provider inválido: "${provider}". Usa "faster" u "openai".`);
    err.status = 400;
    throw err;
  }
  return { language, provider, mode, agentChannel };
}

// ---------- (1) Compat: JSON para análisis (tu endpoint actual) ----------
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Adjunta el archivo en el campo "audio"' });

    const { language, provider, mode, agentChannel } = pickOptsFromBody(req.body);

    const transcript = await transcribeAudio(
      req.file.buffer,
      req.file.originalname,
      language,
      { provider, mode, agentChannel }
    );

    res.json({ ok: true, transcript: toPlainTranscript(transcript), language, provider: provider || '(default .env)' });
  } catch (err) {
    console.error('[TRANSCRIBE JSON][ERROR]', err);
    res.status(err.status || 500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ---------- (2) NUEVO: un solo audio → devuelve TXT (descarga directa) ----------
router.post('/transcribe-txt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Adjunta el archivo en el campo "audio"');

    const { language, provider, mode, agentChannel } = pickOptsFromBody(req.body);

    const transcript = await transcribeAudio(
      req.file.buffer,
      req.file.originalname,
      language,
      { provider, mode, agentChannel }
    );

    const text = toPlainTranscript(transcript);
    const filename = baseTxtName(req.file.originalname) + '.txt';

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(text);
  } catch (err) {
    console.error('[TRANSCRIBE TXT][ERROR]', err);
    res.status(err.status || 500).send(err?.message || String(err));
  }
});

// ---------- (3) NUEVO: múltiples audios → devuelve ZIP con .txt por audio ----------
router.post('/transcribe-zip', upload.array('audios', Number(process.env.BATCH_MAX_FILES || 2000)), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).send('Adjunta archivos en el campo "audios"');

    const { language, provider, mode, agentChannel } = pickOptsFromBody(req.body);

    // ZIP streaming (no guarda en disco)
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="transcripciones_${Date.now()}.zip"`);

    const archive = Archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (e) => { try { res.status(500).end(String(e)); } catch {} });
    archive.pipe(res);

    // Transcribe secuencialmente para no explotar memoria/CPU.
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const transcript = await transcribeAudio(
          f.buffer,
          f.originalname,
          language,
          { provider, mode, agentChannel }
        );
        const text = toPlainTranscript(transcript);
        const name = baseTxtName(f.originalname) + '.txt';
        archive.append(text, { name });
      } catch (e) {
        // En caso de error de una pista, incluimos un TXT con el error para no abortar todo el ZIP
        const name = baseTxtName(f.originalname) + '.ERROR.txt';
        archive.append(`Error transcribiendo "${f.originalname}": ${e?.message || e}`, { name });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('[TRANSCRIBE ZIP][ERROR]', err);
    // Si aún no hemos enviado headers, devolvemos error normal.
    if (!res.headersSent) res.status(err.status || 500).send(err?.message || String(err));
  }
});

export default router;
