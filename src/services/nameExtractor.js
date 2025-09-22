// src/services/nameExtractor.js

// ---------- Utilidades ----------
function isLikelyPersonName(s) {
  if (!s) return false;
  const RE = /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'.-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'.-]+){0,3}$/;
  return RE.test(String(s).trim());
}

function collect(regex, text) {
  const out = [];
  if (!text) return out;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const name = (m[1] || '').trim().replace(/\s+/g, ' ');
    if (isLikelyPersonName(name)) out.push(name);
  }
  return out;
}

function scoreCandidates(list) {
  const map = new Map();
  for (const n of (list || [])) {
    const v = map.get(n) || { name: n, count: 0, score: 0 };
    v.count += 1; v.score += 1;
    map.set(n, v);
  }
  return Array.from(map.values()).sort((a,b)=> (b.score-a.score)||(b.count-a.count));
}
function pickBest(cands) { return (cands && cands[0] && cands[0].name) ? cands[0].name : null; }

// ---------- Heurística local ----------
function extractByHeuristics({ transcript = '', summary = '' }) {
  const NAME = "([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'.-]+(?:\\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'.-]+){0,3})";
  const text = `${summary || ''}\n\n${transcript || ''}`.replace(/\s+/g, ' ').trim();

  const reAgent = new RegExp([
    `mi\\s+nombre\\s+es\\s+${NAME}`,
    `le\\s+habla\\s+${NAME}`,
    `te\\s+habla\\s+${NAME}`,
    `soy\\s+${NAME}`,
    `habla\\s+${NAME}`,
    `agente\\s*[:\\-]\\s*${NAME}`,
    `asesor(?:a)?\\s*[:\\-]\\s*${NAME}`,
    `ejecutiv(?:o|a)\\s*[:\\-]\\s*${NAME}`
  ].join('|'), 'gi');

  const reClient = new RegExp([
    `señor(?:a)?\\s+${NAME}`,
    `sr\\.?\\s+${NAME}`,
    `sra\\.?\\s+${NAME}`,
    `srta\\.?\\s+${NAME}`,
    `don\\s+${NAME}`,
    `doña\\s+${NAME}`,
    `cliente\\s*[:\\-]?\\s*${NAME}`,
    `usuario\\s*[:\\-]?\\s*${NAME}`,
    `paciente\\s*[:\\-]?\\s*${NAME}`,
    `titular\\s*[:\\-]?\\s*${NAME}`,
    `hablo\\s+con\\s+${NAME}`,
    `deudor\\s*[:\\-]?\\s*${NAME}`,
    `encuentra\\s*${NAME}`,
    `¿\\s*(?:señor(?:a)?|sr\\.?|sra\\.?|srta\\.?|cliente|usuario)\\s+${NAME}\\s*\\?`
  ].join('|'), 'gi');

  const agent  = pickBest(scoreCandidates(collect(reAgent, text)));
  const client = pickBest(scoreCandidates(collect(reClient, text)));

  if (agent && client && agent === client) return { agent, client: null };
  return { agent: agent || null, client: client || null };
}

// ---------- Fallback con LLM (lazy import para evitar crash si no se usa) ----------
async function extractWithLLM({ transcript, summary }) {
  if (process.env.NAMES_USE_LLM !== '1') return { agent: null, client: null };

  // Importa 'openai' SOLO si está activado el fallback
  let OpenAI;
  try {
    const mod = await import('openai');
    OpenAI = mod.default ?? mod;
  } catch (e) {
    if (process.env.DEBUG_NAME === '1') {
      console.warn('[nameExtractor] No se pudo cargar "openai":', e?.message || e);
    }
    return { agent: null, client: null };
  }

  try {
    const oa = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY, // <- usa esta env var
      timeout: Number(process.env.OPENAI_TIMEOUT_MS || 120_000),
    });
    const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

    const MAX = Number(process.env.NAMES_MAX_INPUT_CHARS || 3500);
    const text = `${summary || ''}\n\n${transcript || ''}`;
    const clipped = text.length > MAX ? text.slice(0, MAX) : text;

    const resp = await oa.chat.completions.create({
      model, temperature: 0, max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Responde únicamente con el JSON solicitado. No inventes nombres.' },
        { role: 'user', content:
`Extrae SOLO los nombres si están explícitos en la conversación.
Reglas:
- "agent" = quien se presenta como asesor/agente/ejecutivo (frases: "mi nombre es", "le habla", "soy ...").
- "client" = a quien se dirige con "señor/señora/sr./sra./don/doña", o que confirma titularidad.
- Si NO hay evidencia clara, deja el campo vacío.

Devuelve EXCLUSIVAMENTE este JSON:
{"agent": "Nombre Apellido", "client": "Nombre Apellido"}

TEXTO:
${clipped}` }
      ],
    });

    const raw  = resp.choices?.[0]?.message?.content || '';
    let json = null; try { json = JSON.parse(raw); } catch { json = null; }

    const agentName  = (json?.agent  && isLikelyPersonName(json.agent))  ? json.agent.trim()  : null;
    const clientName = (json?.client && isLikelyPersonName(json.client)) ? json.client.trim() : null;

    if (agentName && clientName && agentName === clientName) return { agent: agentName, client: null };
    return { agent: agentName, client: clientName };
  } catch (e) {
    if (process.env.DEBUG_NAME === '1') console.warn('[nameExtractor][LLM][ERROR]', e?.message || e);
    return { agent: null, client: null };
  }
}

// ---------- API pública ----------
export async function extractNames({ transcript = '', summary = '' } = {}) {
  const h = extractByHeuristics({ transcript, summary });
  let agent  = h.agent;
  let client = h.client;

  if ((!agent || !client) && process.env.NAMES_USE_LLM === '1') {
    const llm = await extractWithLLM({ transcript, summary });
    if (!agent  && llm.agent)  agent  = llm.agent;
    if (!client && llm.client) client = llm.client;
  }

  if (process.env.DEBUG_NAME === '1') {
    console.log('[NAMES][DEBUG]', { heuristics: h, final: { agent, client } });
  }
  return { agent, client };
}
