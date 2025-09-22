// src/services/transcriptionService.js
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { Agent, setGlobalDispatcher } from 'undici';

// === Config de timeouts ===
const FW_TIMEOUT_MS         = Number(process.env.FW_TIMEOUT_MS || 600000);         // abort total (10 min)
const FW_HEADERS_TIMEOUT_MS = Number(process.env.FW_HEADERS_TIMEOUT_MS || 600000); // headers (10 min)
const FW_BODY_TIMEOUT_MS    = Number(process.env.FW_BODY_TIMEOUT_MS || 3600000);   // body (60 min)

// Dispatcher global para elevar límites de undici/fetch
setGlobalDispatcher(new Agent({
  headersTimeout: FW_HEADERS_TIMEOUT_MS,
  bodyTimeout: FW_BODY_TIMEOUT_MS
}));

// ← antes tenías const PROVIDER = ...;
// Cambiamos el nombre para dejar claro que es el valor por defecto del .env
const ENV_PROVIDER = (process.env.TRANSCRIBE_PROVIDER || 'faster').toLowerCase().trim();

/**
 * Ahora acepta un 4to parámetro 'opts' donde llegará 'provider' desde la UI.
 * Si 'opts.provider' viene, tiene prioridad sobre ENV_PROVIDER.
 */
export async function transcribeAudio(buffer, filename, language = 'es-ES', opts = {}) {
  if (process.env.SKIP_TRANSCRIPTION === '1') {
    return '(SKIP_TRANSCRIPTION=1) Transcripción omitida (usa el campo transcript del body si está)';
  }

  const provider = (opts.provider || ENV_PROVIDER).toLowerCase().trim();

  if (provider === 'openai') {
    return transcribeAudioOpenAI(buffer, filename, language);
  }

  // provider === 'faster' (local)
  return transcribeAudioLocal(buffer, filename, language);
}

// --- OpenAI Whisper (cloud) ---
async function transcribeAudioOpenAI(buffer, filename, language) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 120000)
  });

  // Más seguro en Node que usar new File(...)
  const file = await toFile(Buffer.from(buffer), filename, {
    type: 'application/octet-stream'
  });

  const model = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
  const lang  = (language || 'es-ES').split('-')[0];

  const resp = await client.audio.transcriptions.create({
    file,
    model,
    language: lang
  });

  return resp?.text || '';
}

// --- Faster-Whisper local (fw-server) ---
async function transcribeAudioLocal(buffer, filename, language) {
  let url = (process.env.FW_SERVER_URL || 'http://127.0.0.1:8000/transcribe')
              .trim()
              .replace('localhost', '127.0.0.1');

  console.log('[FW][POST]', url, 'len=', buffer?.byteLength || buffer?.length, 'lang=', language, 'timeoutMs=', FW_TIMEOUT_MS);

  const fd = new FormData();
  const blob = new Blob([buffer]);
  fd.append('file', blob, filename);
  fd.append('language', (language || 'es-ES').split('-')[0]);

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FW_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: 'POST',
      body: fd,
      signal: ctrl.signal
    });
    clearTimeout(t);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`FW server error ${resp.status}: ${txt}`);
    }
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || 'Faster-Whisper error');
    return json.text || '';
  } catch (e) {
    console.error('[FW][ERROR]', e?.name, e?.message, e?.cause?.code || '');
    throw e;
  }
}
