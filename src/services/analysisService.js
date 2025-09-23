// src/services/analysisService.js
import OpenAI from 'openai';

/** Intenta parsear JSON incluso si el modelo añadió texto alrededor */
function forceJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  try { return JSON.parse(text.replace(/\n/g, ' ').replace(/\r/g, ' ')); } catch {}
  return null;
}

/** Normaliza nombre para matching robusto (quita acentos, colapsa separadores) */
function keyName(x) {
  return String(x || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Limpia honoríficos comunes (Señor, Sra., Don, etc.) */
function cleanName(x = '') {
  const s = String(x).trim();
  if (!s) return '';
  const sinHon = s
    .replace(/^(señor(?:a)?|sr\.?|sra\.?|srta\.?|don|doña)\s+/i, '')
    .trim();
  return sinHon;
}

/** Umbral de criticidad (por peso). Por defecto 100. */
function isCriticalPeso(p) {
  const thr = Number(process.env.CRITICAL_WEIGHT_VALUE || 100);
  const n = Number(p);
  return Number.isFinite(n) && n >= thr;
}

export async function analyzeTranscriptWithMatrix({ transcript, matrix, prompt = '', context = {} }) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 180_000),
  });
  const model        = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
  const MAX_CHARS    = Number(process.env.ANALYSIS_MAX_INPUT_CHARS || 20_000);
  const MAX_TOKENS   = Number(process.env.ANALYSIS_MAX_TOKENS || 1_000);
  const BATCH_SIZE   = Number(process.env.ANALYSIS_BATCH_SIZE || 20);
  const BATCH_TOKENS = Number(process.env.ANALYSIS_BATCH_TOKENS || 700);

  // ---------- Helpers ----------
  const toPlainTranscript = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t === 'object') {
      if (typeof t.text === 'string') return t.text;
      if (Array.isArray(t.segments)) {
        try { return t.segments.map(s => (s?.text || '').trim()).filter(Boolean).join(' '); } catch {}
      }
    }
    try { return JSON.stringify(t); } catch { return String(t); }
  };
  const maybeTruncate = (s, max) => {
    const txt = String(s || '');
    if (!max || txt.length <= max) return txt;
    console.warn(`[analysisService] Transcripción truncada a ${max} chars (original=${txt.length}).`);
    return txt.slice(0, max);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const splitBatches = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };
  const makeReq = (userContent, maxTokens = MAX_TOKENS, extraSystem = []) => ({
    model,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: [
        'Eres un analista de calidad experto en contact center.',
        'Evalúas transcripciones con base en una MATRIZ DE CALIDAD.',
        'Respondes ÚNICAMENTE en JSON válido y en español.',
        'Debes evaluar TODOS los atributos solicitados (no omitas ninguno).',
        'Si no hay evidencia clara, explica la razón en "justificacion" y sigue las reglas de calibración provistas.',
        'No inventes datos fuera de la transcripción.'
      ].join(' ') },
      ...(context?.metodologia || context?.cartera || prompt || (extraSystem && extraSystem.length) ? [{
        role: 'system',
        content: [
          context?.metodologia ? `Metodología: ${context.metodologia}.` : '',
          context?.cartera     ? `Cartera: ${context.cartera}.`         : '',
          prompt ? `Instrucciones de campaña: ${prompt}` : '',
          ...(extraSystem || [])
        ].filter(Boolean).join(' ')
      }] : []),
      { role: 'user', content: userContent },
    ],
  });

  // ---------- Entradas preparadas ----------
  const transcriptText = maybeTruncate(toPlainTranscript(transcript), MAX_CHARS);
  const matrixAsText = (matrix || [])
    .map(m => `- ${m.atributo} | ${m.categoria} | ${m.peso} | ${m.criterio || ''}`)
    .join('\n');
  const expectedAttrNames = (matrix || [])
    .map(r => String(r.atributo ?? r.Atributo ?? '').trim())
    .filter(Boolean);
  const expectedCount = expectedAttrNames.length;

  // ---------- Prompt base (calibración Bogotá + nombres) ----------
  const baseUser = `
Vas a AUDITAR una transcripción contra una MATRIZ DE CALIDAD. Lee con mucha atención el campo "criterio" de cada atributo: ese texto ES LA REGLA.

MATRIZ (atributo | categoría | peso | criterio opcional):
${matrixAsText}

ATRIBUTOS ESPERADOS (${expectedCount}):
- ${expectedAttrNames.join('\n- ')}

TRANSCRIPCIÓN (puede estar truncada si era muy larga):
${transcriptText}

Devuelve JSON ESTRICTAMENTE con el siguiente esquema (sin comentarios):
{
  "agent_name": "string (si el agente se presenta; si no, \"\")",
  "client_name": "string (si el cliente es nombrado; si no, \"\")",
  "resumen": "string (100-200 palabras, sin nombres inventados)",
  "hallazgos": ["string", "string", "string"],
  "atributos": [
    {
      "atributo": "string",
      "categoria": "string",
      "cumplido": true,
      "justificacion": "string (cita/parafrasea evidencia del audio; si NO hay evidencia, explica por qué no)",
      "mejora": "string (si no se cumple, propuesta concreta)",
      "reconocimiento": "string (si se cumple de forma destacada)"
    }
  ],
  "sugerencias_generales": ["string", "string", "string"]
}

REGLAS DE CALIBRACIÓN (OBLIGATORIAS):
- LISTA CERRADA: Evalúa ÚNICAMENTE los atributos listados arriba. No inventes atributos ni cambies los nombres.
- ORDEN: Mantén el MISMO orden que en "ATRIBUTOS ESPERADOS".
- EVIDENCIA: Cada "justificacion" debe citar o parafrasear una frase breve del audio. Si no puedes citar, explica por qué.
- CRÍTICOS (peso=100 por defecto): si NO hay evidencia explícita de CUMPLIMIENTO, marca "cumplido": false (fail-closed) y explica. Esto aplica especialmente a obligaciones legales como Ley 1581 / tratamiento de datos.
- ESCALONAMIENTO (Bogotá): NO es un "plan de pagos". Es ofrecer un SALDO a cobrar que VA BAJANDO en escalas (p.ej. "Saldo $1.200.000 → $900.000 → $700.000"). Si solo hay cuotas/plazos, marca NO CUMPLE.
- DESPEDIDA DE GUION: Valida lo que indique el "criterio" del atributo. Si el guion exige fórmula de despedida específica (agradecimiento + cierre cordial + identidad), debe oírse. Sin evidencia, NO CUMPLE.
- NO HALLUCINATIONS: Si tienes dudas o la transcripción es ambigua, NO supongas cumplimiento. Marca NO CUMPLE y deja una mejora concreta.
- PENALIZACIÓN: Si un atributo se evalúa como afectado/no cumplido, debe quedar "cumplido": false.

REQUISITOS (OBLIGATORIOS):
- "atributos" debe contener EXACTAMENTE ${expectedCount} elementos.
- El orden DEBE seguir "ATRIBUTOS ESPERADOS".
- "atributo" DEBE copiarse exactamente (mismos acentos).
- No incluyas texto fuera del JSON.
- Si no hay evidencia clara de nombres, deja "agent_name" y/o "client_name" como cadena vacía ("").
`.trim();

  // ---------- 1) Intentos normales (hasta 3) ----------
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await client.chat.completions.create(makeReq(baseUser));
      const raw  = completion.choices?.[0]?.message?.content || '';
      const json = forceJson(raw);
      if (!json || !Array.isArray(json.atributos)) {
        throw new Error('El modelo no devolvió JSON válido con "atributos".');
      }
      return finalizeFromLLM(json, matrix);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '').toLowerCase();
      const isTimeoutish =
        msg.includes('timeout') ||
        err?.name?.toLowerCase?.().includes('timeout') ||
        err?.code === 'ETIMEDOUT' ||
        err?.status === 408 || err?.status === 504 || err?.status === 524;

      if (isTimeoutish && attempt < 3) {
        const backoff = 800 * attempt ** 2; // 0.8s, 3.2s
        console.warn(`[analysisService] Timeout. Retry ${attempt}/3 en ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }
      break; // pasamos a intento truncado
    }
  }

  // ---------- 2) Intento final con truncado agresivo ----------
  try {
    const hardMax = Math.floor((MAX_CHARS || 20_000) / 2);
    const smallTranscript = maybeTruncate(toPlainTranscript(transcript), hardMax);

    const userTruncated = `
MATRIZ (atributo | categoría | peso | criterio opcional):
${matrixAsText}

ATRIBUTOS ESPERADOS (${expectedCount}):
- ${expectedAttrNames.join('\n- ')}

TRANSCRIPCIÓN (recortada por tamaño):
${smallTranscript}

Devuelve el MISMO JSON solicitado antes (con TODOS los atributos y en el mismo orden).
`.trim();

    const completion = await client.chat.completions.create(
      makeReq(userTruncated, Math.min(MAX_TOKENS, 800))
    );
    const raw  = completion.choices?.[0]?.message?.content || '';
    const json = forceJson(raw);
    if (json && Array.isArray(json.atributos)) {
      return finalizeFromLLM(json, matrix);
    }
    throw new Error('El modelo no devolvió JSON válido con "atributos" (modo truncado).');
  } catch (err2) {
    lastErr = lastErr || err2;
  }

  // ---------- 3) PLAN B por lotes (si sigue fallando) ----------
  try {
    const result = await analyzeByBatches({
      client, model, transcriptText, matrix, BATCH_SIZE, BATCH_TOKENS
    });
    return result;
  } catch (err3) {
    console.error('[analysisService][PLAN B][ERROR]', err3);
    // Último fallback: estructura válida para no romper el frontend
    const full = (matrix || []).map(row => ({
      atributo: String(row?.atributo ?? row?.Atributo ?? '').trim(),
      categoria: String(row?.categoria ?? row?.Categoria ?? ''),
      peso: Number(row?.peso ?? row?.Peso ?? 0),
      critico: isCriticalPeso(row?.peso ?? row?.Peso ?? 0),
      cumplido: !isCriticalPeso(row?.peso ?? row?.Peso ?? 0), // críticos -> false, no críticos -> true
      justificacion: !isCriticalPeso(row?.peso ?? row?.Peso ?? 0)
        ? 'No se evidencia incumplimiento'
        : 'No se encontró evidencia explícita de cumplimiento (fail-closed por criticidad).',
      mejora: null,
      reconocimiento: null
    }));
    return { agent_name: '', client_name: '', resumen: '', hallazgos: [], atributos: full, sugerencias_generales: [] };
  }
}

/** Une lo que devuelve el LLM con la matriz, garantizando TODOS los atributos en orden */
function finalizeFromLLM(json, matrix) {
  const byName = new Map();
  for (const a of (json.atributos || [])) {
    const k = keyName(a?.atributo);
    if (!k) continue;
    byName.set(k, a);
  }

  const full = [];
  for (const row of (matrix || [])) {
    const nombre = String(row?.atributo ?? row?.Atributo ?? '').trim();
    if (!nombre) continue;

    const found = byName.get(keyName(nombre));
    const categoria = String(found?.categoria ?? (row?.categoria ?? row?.Categoria ?? '')).trim();
    const peso = Number(row?.peso ?? row?.Peso ?? 0);
    const critico = isCriticalPeso(peso);

    // Si el LLM no devolvió "cumplido", aplicamos default:
    // - CRÍTICO -> false (fail-closed)
    // - NO crítico -> true
    let cumplido;
    if (typeof found?.cumplido === 'boolean') {
      cumplido = found.cumplido;
    } else {
      cumplido = critico ? false : true;
    }

    const justif = (found?.justificacion || '').trim();
    const defaultJustif = cumplido
      ? 'No se evidencia incumplimiento'
      : (critico
          ? 'No se encontró evidencia explícita de cumplimiento (fail-closed por criticidad).'
          : 'Incumplimiento detectado o evidencia insuficiente.');
    const mejora = (found?.mejora ?? (cumplido ? null : 'Definir acciones concretas para cumplir el criterio.'));

    full.push({
      atributo: nombre,
      categoria,
      peso,
      critico,
      cumplido,
      justificacion: justif || defaultJustif,
      mejora,
      reconocimiento: found?.reconocimiento ?? null
    });
  }

  return {
    agent_name: typeof json.agent_name === 'string' ? cleanName(json.agent_name) : '',
    client_name: typeof json.client_name === 'string' ? cleanName(json.client_name) : '',
    resumen: json.resumen,
    hallazgos: Array.isArray(json.hallazgos) ? json.hallazgos : [],
    atributos: full,
    sugerencias_generales: Array.isArray(json.sugerencias_generales) ? json.sugerencias_generales : []
  };
}

/** Plan B: evalúa SOLO "atributos" por lotes y los une en el orden de la matriz */
async function analyzeByBatches({ client, model, transcriptText, matrix, BATCH_SIZE, BATCH_TOKENS }) {
  const batches = [];
  for (let i = 0; i < matrix.length; i += BATCH_SIZE) {
    batches.push(matrix.slice(i, i + BATCH_SIZE));
  }

  const atributosAll = [];
  for (const batch of batches) {
    const batchNames = batch
      .map(r => String(r.atributo ?? r.Atributo ?? '').trim())
      .filter(Boolean);

    const batchUser = `
Evalúa SOLO los siguientes atributos (en el MISMO orden) y devuelve ÚNICAMENTE este JSON:
{
  "atributos": [
    {
      "atributo": "string (copiar exactamente de la lista)",
      "categoria": "string",
      "cumplido": true,
      "justificacion": "string",
      "mejora": "string",
      "reconocimiento": "string"
    }
  ]
}

LISTA DE ATRIBUTOS (${batchNames.length}):
- ${batchNames.join('\n- ')}

TRANSCRIPCIÓN (puede estar truncada):
${transcriptText}
`.trim();

    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: BATCH_TOKENS,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Responde SOLO el objeto JSON con "atributos".' },
        { role: 'user', content: batchUser }
      ],
    });
    const raw  = completion.choices?.[0]?.message?.content || '';
    const json = forceJson(raw);
    if (!json || !Array.isArray(json.atributos)) {
      throw new Error('El modelo no devolvió "atributos" en un batch.');
    }
    atributosAll.push(...json.atributos);
  }

  // Unión por nombre y orden de la matriz
  const byName = new Map();
  for (const a of atributosAll) {
    const k = keyName(a?.atributo);
    if (!k) continue;
    byName.set(k, a);
  }

  const full = (matrix || []).map(row => {
    const nombre = String(row?.atributo ?? row?.Atributo ?? '').trim();
    const found  = byName.get(keyName(nombre));

    const categoria = String(found?.categoria ?? (row?.categoria ?? row?.Categoria ?? '')).trim();
    const peso = Number(row?.peso ?? row?.Peso ?? 0);
    const critico = isCriticalPeso(peso);

    let cumplido;
    if (typeof found?.cumplido === 'boolean') {
      cumplido = found.cumplido;
    } else {
      cumplido = critico ? false : true;
    }

    const justif = (found?.justificacion || '').trim();
    const defaultJustif = cumplido
      ? 'No se evidencia incumplimiento'
      : (critico
          ? 'No se encontró evidencia explícita de cumplimiento (fail-closed por criticidad).'
          : 'Incumplimiento detectado o evidencia insuficiente.');
    const mejora = (found?.mejora ?? (cumplido ? null : 'Definir acciones concretas para cumplir el criterio.'));

    return {
      atributo: nombre,
      categoria,
      peso,
      critico,
      cumplido,
      justificacion: justif || defaultJustif,
      mejora,
      reconocimiento: found?.reconocimiento ?? null
    };
  });

  // Mini llamada para resumen/hallazgos + NOMBRES (ligera)
  const miniUser = `
A partir de la transcripción, devuelve ÚNICAMENTE este JSON:
{
  "agent_name": "string (si el agente se presenta; si no, \"\")",
  "client_name": "string (si el cliente es nombrado; si no, \"\")",
  "resumen": "100-200 palabras",
  "hallazgos": ["string","string","string"],
  "sugerencias_generales": ["string","string","string"]
}

REGLAS:
- No inventes nombres; si no hay evidencia explícita, deja el campo vacío "".
- Quita honoríficos (Señor/Sra./Sr./Sra./Don/Doña) si aparecen.

TRANSCRIPCIÓN (puede estar truncada):
${transcriptText}
`.trim();

  let agent_name = '', client_name = '';
  let resumen = '', hallazgos = [], sugerencias_generales = [];
  try {
    const mini = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 450,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'No incluyas nombres inventados. Responde SOLO el objeto JSON solicitado.' },
        { role: 'user', content: miniUser },
      ],
    });
    const rawMini  = mini.choices?.[0]?.message?.content || '';
    const jsonMini = forceJson(rawMini);
    if (jsonMini) {
      agent_name = typeof jsonMini.agent_name === 'string' ? cleanName(jsonMini.agent_name) : '';
      client_name = typeof jsonMini.client_name === 'string' ? cleanName(jsonMini.client_name) : '';
      resumen = jsonMini.resumen || '';
      hallazgos = Array.isArray(jsonMini.hallazgos) ? jsonMini.hallazgos : [];
      sugerencias_generales = Array.isArray(jsonMini.sugerencias_generales) ? jsonMini.sugerencias_generales : [];
    }
  } catch { /* si falla, devolvemos vacío sin romper */ }

  return { agent_name, client_name, resumen, hallazgos, atributos: full, sugerencias_generales };
}
