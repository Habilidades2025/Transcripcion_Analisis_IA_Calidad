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

// === Helpers ===
function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Determina si un atributo es "crítico".
 * Regla:
 *  - Si el objeto trae `critico: true`, es crítico.
 *  - Si su categoría contiene "crítico"/"critico", es crítico.
 *  - Si no hay marca explícita, se usa un umbral por peso (env CRITICAL_WEIGHT_THRESHOLD, por defecto 10).
 */
function isCritical(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (typeof attr.critico === 'boolean') return attr.critico;

  const cat = String(attr.categoria || attr.category || '').toLowerCase();
  if (cat.includes('crítico') || cat.includes('critico')) return true;

  const thr = Number(process.env.CRITICAL_WEIGHT_THRESHOLD ?? 10);
  const peso = Number(attr.peso);
  return Number.isFinite(peso) && peso >= thr;
}

/** Separa atributos NO cumplidos en críticos vs no críticos y devuelve sus nombres */
function splitAffected(consolidado) {
  const arr = Array.isArray(consolidado?.porAtributo) ? consolidado.porAtributo : [];
  const incumplidos = arr.filter(a => a && a.cumplido === false);

  const criticos = [];
  const noCriticos = [];
  for (const a of incumplidos) {
    const nombre = a?.atributo || a?.nombre || '(sin nombre)';
    if (isCritical(a)) criticos.push(nombre);
    else noCriticos.push(nombre);
  }
  return { criticos, noCriticos };
}

// === Audits (con paginación opcional) ===
router.get('/audits', (req, res) => {
  const hasPaging = (req.query.offset !== undefined) || (req.query.limit !== undefined);
  if (hasPaging && typeof listAuditsPage === 'function') {
    const offset = toInt(req.query.offset, 0);
    const limit  = toInt(req.query.limit,  200); // página por defecto
    const order  = (req.query.order === 'asc') ? 'asc' : 'desc';
    const { total, items } = listAuditsPage({ offset, limit, order });
    return res.json({ total, items });
  }

  // compat: retorna TODO (puede ser pesado con 10k+ audits)
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
    const limit  = toInt(req.query.limit,  1000); // export parcial por defecto
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
    const limit  = toInt(req.query.limit,  5000); // ojo: Excel gigantes pueden pesar
    items = listAuditsPage({ offset, limit, order: 'desc' }).items;
  } else {
    items = listAudits();
  }

  const rows = items.map(it => {
    const { criticos, noCriticos } = splitAffected(it?.consolidado);
    const fecha = it?.metadata?.timestamp
      ? new Date(it.metadata.timestamp).toLocaleString()
      : '';

    // Fallbacks robustos para nombres y resumen
    const agente  = it?.metadata?.agentName    || it?.analisis?.agent_name  || '';
    const cliente = it?.metadata?.customerName || it?.analisis?.client_name || '';
    const resumen = it?.analisis?.resumen
      ? String(it.analisis.resumen).replace(/\s+/g, ' ').trim()
      : '';

    return {
      'ID de la llamada': it?.metadata?.callId ?? '',
      'Fecha': fecha,
      'Agente': agente,
      'Cliente': cliente,
      'Nota': it?.consolidado?.notaFinal ?? '',
      'Atributos no críticos afectados': noCriticos.join(', '),
      'Atributos críticos afectados': criticos.join(', '),
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

// === Servir reportes MD (individuales o de lote) por nombre/ubicación conocida ===
router.get('/audits/files/:name', (req, res) => {
  const base = path.basename(req.params.name); // sanitiza
  // Primero intentamos con helper (busca en /reports, /reports/batches, o ruta absoluta/relativa válida)
  const abs = resolveReportFile(base) || resolveReportFile(req.params.name);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).send('Reporte no encontrado');
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});

// === Lotes (bloques) ===

// Lista metadatos de lotes procesados
router.get('/audits/batches', (_req, res) => {
  const items = listBatches();
  res.json({ total: items.length, items });
});

// Descarga/visualiza el reporte .md de un lote por ID
router.get('/audits/batches/:id/report.md', (req, res) => {
  const abs = getBatchReportPath(req.params.id);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).send('Reporte de lote no encontrado');
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});

// === (Opcional) Servir transcripciones externas si STORE_TRANSCRIPT_INLINE=0 ===
//     Esto expone /audits/transcripts/YYYY/MM/<id>.txt
router.use(
  '/audits/transcripts',
  express.static(path.resolve('data', 'transcripts'), { fallthrough: true })
);

export default router;
