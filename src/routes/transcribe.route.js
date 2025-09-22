// src/routes/transcribe.route.js
import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;

import multerPkg from 'multer';
const multer = multerPkg.default ?? multerPkg;

import { transcribeAudio } from '../services/transcriptionService.js';

// Usamos memoria para evitar archivos temporales en disco.
// Límite de 100 MB (ajústalo si necesitas audios más grandes).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const router = express.Router();

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Adjunta el archivo en el campo "audio"' });
    }

    // Normaliza parámetros opcionales del formulario
    const language = (req.body?.language || 'es-ES').trim();

    // 👇 NUEVO: proveedor que viene desde la UI (faster | openai)
    const provider = (req.body?.provider || '').toString().trim().toLowerCase();

    // (Opcional) si más adelante agregas detección estéreo/mono desde la UI
    const mode = (req.body?.mode || '').toString().trim().toLowerCase(); // 'mono' | 'stereo'
    const agentChannelRaw = req.body?.agentChannel;
    const agentChannel = Number.isFinite(Number(agentChannelRaw)) ? Number(agentChannelRaw) : undefined;

    // Validación suave del provider (si no viene, el servicio usará el valor por defecto del .env)
    const allowed = new Set(['faster', 'openai', '']);
    if (!allowed.has(provider)) {
      return res.status(400).json({ ok: false, error: `provider inválido: "${provider}". Usa "faster" u "openai".` });
    }

    // Llamada al servicio pasando opts con provider (y mode/agentChannel si los usas)
    const text = await transcribeAudio(
      req.file.buffer,
      req.file.originalname,
      language,
      { provider, mode, agentChannel }
    );

    res.json({ ok: true, transcript: text, language, provider: provider || '(default .env)' });
  } catch (err) {
    console.error('[TRANSCRIBE][ERROR]', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
