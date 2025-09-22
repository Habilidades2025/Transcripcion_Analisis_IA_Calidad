// src/services/persistService.js
import fs from 'fs';
import path from 'path';

const ROOT            = path.resolve('data');
const AUDITS_DIR      = path.join(ROOT, 'audits');
const TRANS_DIR       = path.join(ROOT, 'transcripts');
const INDEX_PATH      = path.join(AUDITS_DIR, '_index.json');   // [{id, ts, path, agent, client, nota}]
const SUMM_PATH       = path.join(AUDITS_DIR, '_summary.json'); // { total, totalScore, byAgent:{}, byAttr:{} }

// NUEVO: rutas para lotes y reportes .md
const BATCH_META_DIR      = path.join(ROOT, 'batches');               // guarda metadatos de lotes
const REPORTS_DIR         = path.resolve('reports');                  // reportes individuales
const REPORTS_BATCH_DIR   = path.join(REPORTS_DIR, 'batches');        // reportes por bloque

ensureDir(ROOT);
ensureDir(AUDITS_DIR);
ensureDir(BATCH_META_DIR);
ensureDir(REPORTS_DIR);
ensureDir(REPORTS_BATCH_DIR);

ensureFile(INDEX_PATH, '[]');
ensureFile(SUMM_PATH, JSON.stringify({ total: 0, totalScore: 0, byAgent: {}, byAttr: {} }));

// ---------- Utils base ----------
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function ensureFile(p, initial = '') { if (!fs.existsSync(p)) fs.writeFileSync(p, initial, 'utf-8'); }
function readJsonSafe(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; } }
function writeJsonPretty(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8'); }
function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function pad2(n) { return String(n).padStart(2, '0'); }

// ---------- Guardar auditoría (sharding + externalización opcional de transcript) ----------
export function saveAudit(audit = {}) {
  const ts = audit?.metadata?.timestamp ?? Date.now();
  const callId = String(audit?.metadata?.callId || ts);
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm   = pad2(d.getMonth() + 1);

  const shardDir = path.join(AUDITS_DIR, String(yyyy), String(mm));
  ensureDir(shardDir);

  // Backfill nombres desde análisis si faltan en metadata
  const agentFromAnalysis  = audit?.analisis?.agent_name  || '';
  const clientFromAnalysis = audit?.analisis?.client_name || '';

  // (Opcional) mover transcripción a archivo de texto
  const externalTrans = (process.env.STORE_TRANSCRIPT_INLINE || '1') !== '1';
  let transcriptPath = null;
  let transcript = audit.transcript;

  if (externalTrans && transcript) {
    const tDir = path.join(TRANS_DIR, String(yyyy), String(mm));
    ensureDir(tDir);
    transcriptPath = path.join(tDir, `${callId}.txt`);
    const text = toPlainTranscript(transcript);
    fs.writeFileSync(transcriptPath, text, 'utf-8');
    transcript = undefined; // aligerar JSON
  }

  const filePath = path.join(shardDir, `${callId}.json`);
  const payload = {
    ...audit,
    transcript: transcript, // si externalTrans=false, se mantiene
    transcriptPath: transcriptPath ? relToData(transcriptPath) : (audit.transcriptPath || null),
    metadata: {
      ...(audit.metadata || {}),
      callId,
      agentName:    audit?.metadata?.agentName    || agentFromAnalysis || '-',
      customerName: audit?.metadata?.customerName || clientFromAnalysis || '-',
      timestamp: ts
    }
  };

  writeJsonPretty(filePath, payload);

  // Actualiza índice incremental
  const idx = readJsonSafe(INDEX_PATH, []);
  idx.push({
    id: callId,
    ts,
    path: relToData(filePath),
    agent:  payload.metadata.agentName,
    client: payload.metadata.customerName,
    nota:   toNum(payload?.consolidado?.notaFinal)
  });
  writeJsonPretty(INDEX_PATH, idx);

  // Actualiza resumen incremental
  const summ = readJsonSafe(SUMM_PATH, { total: 0, totalScore: 0, byAgent: {}, byAttr: {} });
  summ.total += 1;
  summ.totalScore += toNum(payload?.consolidado?.notaFinal);

  const ag = (payload.metadata.agentName || 'Sin agente').trim();
  summ.byAgent[ag] = summ.byAgent[ag] || { count: 0, sum: 0 };
  summ.byAgent[ag].count += 1;
  summ.byAgent[ag].sum   += toNum(payload?.consolidado?.notaFinal);

  const attrs = Array.isArray(payload?.consolidado?.porAtributo) ? payload.consolidado.porAtributo : [];
  for (const a of attrs) {
    const name = String(a?.atributo || a?.categoria || 'Atributo').trim();
    summ.byAttr[name] = summ.byAttr[name] || { total: 0, ok: 0 };
    summ.byAttr[name].total += 1;
    if (a?.cumplido === true) summ.byAttr[name].ok += 1;
  }
  writeJsonPretty(SUMM_PATH, summ);

  return filePath;
}

// ---------- Listado completo (compat; pesado para 10k) ----------
export function listAudits() {
  const idx = readJsonSafe(INDEX_PATH, []);
  const items = [];
  for (let i = idx.length - 1; i >= 0; i--) { // más reciente primero
    const p = absFromData(idx[i].path);
    const obj = readJsonSafe(p);
    if (obj) items.push(obj);
  }
  return items;
}

// ---------- Listado paginado (recomendado) ----------
export function listAuditsPage({ offset = 0, limit = 100, order = 'desc' } = {}) {
  const idx = readJsonSafe(INDEX_PATH, []);
  const total = idx.length;

  let slice;
  if (order === 'desc') {
    const start = Math.max(0, total - offset - limit);
    const end   = Math.max(0, total - offset);
    slice = idx.slice(start, end);
  } else {
    slice = idx.slice(offset, offset + limit);
  }

  const items = slice
    .sort((a, b) => (order === 'desc' ? b.ts - a.ts : a.ts - b.ts))
    .map(e => readJsonSafe(absFromData(e.path)))
    .filter(Boolean);

  return { total, items };
}

// ---------- Resumen O(1) desde cache ----------
export function summaryAudits() {
  const summ = readJsonSafe(SUMM_PATH, { total: 0, totalScore: 0, byAgent: {}, byAttr: {} });

  const total = summ.total;
  const promedio = total ? Math.round(summ.totalScore / total) : 0;

  const porAgente = Object.entries(summ.byAgent).map(([ag, v]) => ({
    agente: ag || 'Sin agente',
    total: v.count,
    promedio: v.count ? Math.round(v.sum / v.count) : 0
  })).sort((a, b) => b.total - a.total || a.agente.localeCompare(b.agente));

  const porCategoria = Object.entries(summ.byAttr).map(([attr, v]) => ({
    atributo: attr,
    porcentaje: v.total ? Math.round((v.ok / v.total) * 100) : 0
  })).sort((a, b) => b.porcentaje - a.porcentaje || a.atributo.localeCompare(b.atributo));

  // formato legado
  const byAgentLegacy = {};
  for (const a of porAgente) byAgentLegacy[a.agente] = { count: a.total, avgScore: a.promedio };
  const byCategoryLegacy = {};
  for (const c of porCategoria) byCategoryLegacy[c.atributo] = { count: 0, avgCumplimiento: c.porcentaje };

  return {
    totalCalls: total,
    averageScore: promedio,
    byAgent: byAgentLegacy,
    byCategory: byCategoryLegacy,
    total, promedio, porAgente, porCategoria
  };
}

// ---------- NUEVO: lotes (batches) ----------
/** Devuelve lista de lotes con su metadato (ordenados por fecha descendente) */
export function listBatches() {
  ensureDir(BATCH_META_DIR);
  const files = fs.readdirSync(BATCH_META_DIR).filter(f => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    const meta = readJsonSafe(path.join(BATCH_META_DIR, f));
    if (meta) items.push(meta);
  }
  items.sort((a, b) => (b?.createdAt || 0) - (a?.createdAt || 0));
  return items;
}

/** Devuelve ruta absoluta del reporte .md de un lote (o null si no existe) */
export function getBatchReportPath(batchId) {
  const metaPath = path.join(BATCH_META_DIR, `${batchId}.json`);
  const meta = readJsonSafe(metaPath);
  if (!meta || !meta.reportPath) return null;
  return path.isAbsolute(meta.reportPath)
    ? meta.reportPath
    : path.resolve(meta.reportPath);
}

// ---------- NUEVO: helpers para servir reportes .md ----------
/** Intenta resolver un nombre de archivo de reporte a ruta absoluta segura. */
export function resolveReportFile(nameOrPath) {
  if (!nameOrPath) return null;
  const base = path.basename(String(nameOrPath));
  // 1) reportes individuales
  const p1 = path.join(REPORTS_DIR, base);
  if (fs.existsSync(p1)) return p1;
  // 2) reportes de lotes
  const p2 = path.join(REPORTS_BATCH_DIR, base);
  if (fs.existsSync(p2)) return p2;
  // 3) permitir path relativo (producido desde meta)
  const maybe = path.isAbsolute(nameOrPath)
    ? nameOrPath
    : path.resolve(nameOrPath);
  if (fs.existsSync(maybe)) return maybe;
  return null;
}

// ---------- Utilidades internas ----------
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
function relToData(absPath) { return path.relative(ROOT, absPath).replace(/\\/g, '/'); }
function absFromData(rel) { return path.join(ROOT, rel); }

// ---------- (Opcional) reconstrucción completa ----------
export function rebuildIndexes() {
  ensureDir(AUDITS_DIR);
  const all = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
        all.push(p);
      }
    }
  };
  walk(AUDITS_DIR);

  const idx = [];
  const summ = { total: 0, totalScore: 0, byAgent: {}, byAttr: {} };

  for (const p of all) {
    const obj = readJsonSafe(p);
    if (!obj) continue;
    const ts   = obj?.metadata?.timestamp ?? Date.now();
    const id   = String(obj?.metadata?.callId || ts);
    const ag   = (obj?.metadata?.agentName || obj?.analisis?.agent_name || '-').trim();
    const cli  = (obj?.metadata?.customerName || obj?.analisis?.client_name || '-').trim();
    const nota = toNum(obj?.consolidado?.notaFinal);

    idx.push({ id, ts, path: relToData(p), agent: ag, client: cli, nota });

    summ.total += 1;
    summ.totalScore += nota;

    summ.byAgent[ag] = summ.byAgent[ag] || { count: 0, sum: 0 };
    summ.byAgent[ag].count += 1;
    summ.byAgent[ag].sum   += nota;

    const attrs = Array.isArray(obj?.consolidado?.porAtributo) ? obj.consolidado.porAtributo : [];
    for (const a of attrs) {
      const name = String(a?.atributo || a?.categoria || 'Atributo').trim();
      summ.byAttr[name] = summ.byAttr[name] || { total: 0, ok: 0 };
      summ.byAttr[name].total += 1;
      if (a?.cumplido === true) summ.byAttr[name].ok += 1;
    }
  }
  writeJsonPretty(INDEX_PATH, idx.sort((a, b) => a.ts - b.ts));
  writeJsonPretty(SUMM_PATH, summ);
}
