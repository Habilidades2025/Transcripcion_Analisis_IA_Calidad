// src/routes/audits.route.js
import expressPkg from 'express';
const express = (expressPkg.default ?? expressPkg);

import fs from 'fs';
import path from 'path';

import xlsxPkg from 'xlsx'; // XLSX para generar Excel
const XLSX = xlsxPkg?.default ?? xlsxPkg;

import {
  listAudits,
  summaryAudits,
  listAuditsPage,
  listBatches,
  resolveReportFile,
  getBatchReportPath,
} from '../services/persistService.js';

const router = express.Router();

// === Paths base (por si luego quieres materializar MDs)
const REPORTS_DIR       = path.resolve('reports');
const REPORTS_CALL_DIR  = path.join(REPORTS_DIR, 'calls');
const REPORTS_BATCH_DIR = path.join(REPORTS_DIR, 'batches');

// === Helpers ===
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function toInt(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }

function isCritical(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (typeof attr.critico === 'boolean') return attr.critico;
  const cat = String(attr.categoria || attr.category || '').toLowerCase();
  if (cat.includes('crítico') || cat.includes('critico')) return true;
  const thr = Number(process.env.CRITICAL_WEIGHT_THRESHOLD ?? 10);
  const peso = Number(attr.peso);
  return Number.isFinite(peso) && peso >= thr;
}

function splitAffected(consolidado) {
  const arr = Array.isArray(consolidado?.porAtributo) ? consolidado.porAtributo : [];
  const incumplidos = arr.filter(a => a && a.cumplido === false);
  const criticos = [], noCriticos = [];
  for (const a of incumplidos) {
    const nombre = a?.atributo || a?.nombre || '(sin nombre)';
    (isCritical(a) ? criticos : noCriticos).push(nombre);
  }
  return { criticos, noCriticos };
}

function buildFraudString(analisis) {
  if (!analisis || !Array.isArray(analisis?.fraude?.alertas)) return '';
  return analisis.fraude.alertas
    .map(a => {
      const tipo   = String(a?.tipo   || '').replace(/_/g, ' ');
      const riesgo = String(a?.riesgo || 'alto');
      const cita   = String(a?.cita   || '').trim();
      return `[${riesgo}] ${tipo}${cita ? ` — "${cita}"` : ''}`;
    })
    .join(' | ');
}

/** Genera un MD de una auditoría individual (sin guardar a disco) */
function buildCallMarkdown(audit) {
  const lines = [];
  const meta = audit?.metadata || {};
  const an   = audit?.analisis  || {};
  const cons = audit?.consolidado || {};

  const fecha = meta.timestamp ? new Date(meta.timestamp).toLocaleString() : '';
  const agente  = meta.agentName    || an.agent_name  || '-';
  const cliente = meta.customerName || an.client_name || '-';
  const nota    = cons?.notaFinal ?? 0;

  const { criticos, noCriticos } = splitAffected(cons);
  const fraudes = Array.isArray(an?.fraude?.alertas) ? an.fraude.alertas : [];

  lines.push(`# Reporte de Llamada — ${meta.callId || '(sin id)'}\n`);
  lines.push(`**Fecha:** ${fecha}  `);
  lines.push(`**Agente:** ${agente}  `);
  lines.push(`**Cliente:** ${cliente}  `);
  lines.push(`**Nota:** ${nota}/100`);
  lines.push('\n## Resumen\n');
  lines.push(an?.resumen || '—');
  lines.push('\n## Hallazgos');
  if (Array.isArray(an?.hallazgos) && an.hallazgos.length) {
    for (const h of an.hallazgos) lines.push(`- ${h}`);
  } else {
    lines.push('- —');
  }
  lines.push('\n## Afectados (críticos)');
  lines.push(criticos.length ? `- ${criticos.join('\n- ')}` : '- —');

  lines.push('\n## Afectados (no críticos)');
  lines.push(noCriticos.length ? `- ${noCriticos.join('\n- ')}` : '- —');

  lines.push('\n## Sugerencias');
  if (Array.isArray(an?.sugerencias_generales) && an.sugerencias_generales.length) {
    for (const s of an.sugerencias_generales) lines.push(`- ${s}`);
  } else {
    lines.push('- —');
  }

  lines.push('\n## Alertas de fraude');
  if (fraudes.length) {
    for (const f of fraudes) {
      const tipo = String(f?.tipo || '').replace(/_/g, ' ');
      const riesgo = String(f?.riesgo || 'alto');
      const cita = String(f?.cita || '').trim();
      lines.push(`- **${tipo}** [${riesgo}]${cita ? ` — "${cita}"` : ''}`);
    }
  } else {
    lines.push('- —');
  }

  return lines.join('\n');
}

// === Audits (con paginación opcional) ===
router.get('/audits', (req, res) => {
  const hasPaging = (req.query.offset !== undefined) || (req.query.limit !== undefined);
  if (hasPaging && typeof listAuditsPage === 'function') {
    const offset = toInt(req.query.offset, 0);
    const limit  = toInt(req.query.limit,  200);
    const order  = (req.query.order === 'asc') ? 'asc' : 'desc';
    const { total, items } = listAuditsPage({ offset, limit, order });
    return res.json({ total, items });
  }
  const items = listAudits();
  res.json({ total: items.length, items });
});

router.get('/audits/summary', (_req, res) => {
  const s = summaryAudits();
  res.json(s);
});

// === Export JSON (con paginación opcional) ===
router.get('/audits/export.json', (req, res) => {
  const hasPaging = (req.query.offset !== undefined) || (req.query.limit !== undefined);
  let items = [];
  if (hasPaging && typeof listAuditsPage === 'function') {
    const offset = toInt(req.query.offset, 0);
    const limit  = toInt(req.query.limit,  1000);
    items = listAuditsPage({ offset, limit, order: 'desc' }).items;
  } else {
    items = listAudits();
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="audits.json"');
  res.send(JSON.stringify(items, null, 2));
});

// === Export a Excel (con paginación opcional) ===
router.get('/audits/export.xlsx', (req, res) => {
  const hasPaging = (req.query.offset !== undefined) || (req.query.limit !== undefined);
  let items = [];
  if (hasPaging && typeof listAuditsPage === 'function') {
    const offset = toInt(req.query.offset, 0);
    const limit  = toInt(req.query.limit,  5000);
    items = listAuditsPage({ offset, limit, order: 'desc' }).items;
  } else {
    items = listAudits();
  }

  const rows = items.map(it => {
    const { criticos, noCriticos } = splitAffected(it?.consolidado);
    const fecha = it?.metadata?.timestamp ? new Date(it.metadata.timestamp).toLocaleString() : '';
    const agente  = it?.metadata?.agentName    || it?.analisis?.agent_name  || '';
    const cliente = it?.metadata?.customerName || it?.analisis?.client_name || '';
    const resumen = it?.analisis?.resumen ? String(it.analisis.resumen).replace(/\s+/g, ' ').trim() : '';
    const fraude  = buildFraudString(it?.analisis);

    return {
      'ID de la llamada': it?.metadata?.callId ?? '',
      'Fecha': fecha,
      'Agente': agente,
      'Cliente': cliente,
      'Nota': it?.consolidado?.notaFinal ?? '',
      'Atributos no críticos afectados': noCriticos.join(', '),
      'Atributos críticos afectados': criticos.join(', '),
      'Alerta de fraude': fraude,
      'Resumen': resumen
    };
  });

  const headers = [
    'ID de la llamada',
    'Fecha',
    'Agente',
    'Cliente',
    'Nota',
    'Atributos no críticos afectados',
    'Atributos críticos afectados',
    'Alerta de fraude',
    'Resumen',
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  XLSX.utils.book_append_sheet(wb, ws, 'Consolidado');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="consolidado.xlsx"');
  res.send(buf);
});

// === Servir reportes MD (individuales o de lote) ===
// 1) rutas explícitas (por si decides usarlas)
router.get('/audits/files/calls/:callId.md', (req, res) => {
  const callId = req.params.callId.replace(/\.md$/, '');
  const abs = path.join(REPORTS_CALL_DIR, `${callId}.md`);
  if (!fs.existsSync(abs)) return res.status(404).send('Reporte no encontrado');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});
router.get('/audits/files/batches/:jobId.md', (req, res) => {
  const jobId = req.params.jobId.replace(/\.md$/, '');
  const abs = path.join(REPORTS_BATCH_DIR, `${jobId}.md`);
  if (!fs.existsSync(abs)) return res.status(404).send('Reporte no encontrado');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});

// 2) resolvedor genérico y **fallback dinámico** si no existe el archivo .md
router.get('/audits/files/:name', (req, res) => {
  const base = path.basename(req.params.name);     // ej: 1759..._1.md
  const callId = base.replace(/\.md$/,'');         // ej: 1759..._1
  const withExt = base.endsWith('.md') ? base : `${base}.md`;

  // Candidatos comunes
  const candidates = [
    resolveReportFile(base),
    resolveReportFile(req.params.name),
    path.join(REPORTS_CALL_DIR, withExt),
    path.join(REPORTS_DIR, withExt),
  ].filter(Boolean);

  const existing = candidates.find(p => fs.existsSync(p));
  if (existing) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(fs.readFileSync(existing, 'utf-8'));
  }

  // ---- Fallback: construir MD al vuelo desde el JSON de /data/audits/YYYY/MM ----
  try {
    const items = listAudits(); // lee todos los JSON ya guardados
    const audit = items.find(a => String(a?.metadata?.callId || '') === callId);
    if (!audit) return res.status(404).send('Reporte no encontrado');

    const md = buildCallMarkdown(audit);

    // (opcional) cachear para futuras visitas
    try {
      ensureDir(REPORTS_CALL_DIR);
      fs.writeFileSync(path.join(REPORTS_CALL_DIR, `${callId}.md`), md, 'utf-8');
    } catch { /* si no se puede escribir, igual devolvemos el MD */ }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(md);
  } catch (e) {
    return res.status(404).send('Reporte no encontrado');
  }
});

// === Lotes (bloques) ===
router.get('/audits/batches', (_req, res) => {
  const items = listBatches();
  res.json({ total: items.length, items });
});
router.get('/audits/batches/:id/report.md', (req, res) => {
  const abs = getBatchReportPath(req.params.id);
  if (!abs || !fs.existsSync(abs)) return res.status(404).send('Reporte de lote no encontrado');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});

// === (Opcional) Servir transcripciones externas si STORE_TRANSCRIPT_INLINE=0 ===
router.use(
  '/audits/transcripts',
  express.static(path.resolve('data', 'transcripts'), { fallthrough: true })
);

export default router;
