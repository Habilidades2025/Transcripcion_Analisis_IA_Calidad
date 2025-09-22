// src/routes/batch.route.js
import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;

import multerPkg from 'multer';
const multer = multerPkg.default ?? multerPkg;

import { EventEmitter } from 'events';

import fs from 'fs';
import path from 'path';

import { parseMatrixFromXlsx } from '../services/matrixService.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { analyzeTranscriptWithMatrix } from '../services/analysisService.js';
import { scoreFromMatrix } from '../services/scoringService.js';
import { saveAudit } from '../services/persistService.js';

// ---- Multer (memoria)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.BATCH_MAX_FILE_SIZE || 100 * 1024 * 1024) } // 100MB c/u
});

// ---- Router
const router = express.Router();

// ---- Store de jobs en memoria
// job: { id, status: 'queued'|'running'|'done'|'error', total, done, items:[{name,status,callId,meta?}], em:EE, group?:{} }
const jobs = new Map();

// ---- Paths para reportes de lotes
const REPORTS_BATCH_DIR = path.resolve('reports', 'batches');

// ---- Helpers
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function payload(job) {
  return { status: job.status, total: job.total, done: job.done, items: job.items, group: job.group ?? null };
}
function notify(job) {
  job.em?.emit('progress', payload(job));
}
function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function cleanName(x = '') {
  return String(x).trim().replace(/^(señor(?:a)?|sr\.?|sra\.?|srta\.?|don|doña)\s+/i, '').trim();
}

// Criticidad de atributos
function isCritical(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (typeof attr.critico === 'boolean') return attr.critico;
  const cat = String(attr.categoria || attr.category || '').toLowerCase();
  if (cat.includes('crítico') || cat.includes('critico')) return true;
  const thr = Number(process.env.CRITICAL_WEIGHT_THRESHOLD ?? 10);
  const peso = Number(attr.peso);
  return Number.isFinite(peso) && peso >= thr;
}

// Compacta lo que enviaremos al front por cada audit (sin transcripción)
function compactAuditForFront(audit) {
  const afectNoCrit = [];
  const afectCrit   = [];
  const porAtrib = Array.isArray(audit?.consolidado?.porAtributo) ? audit.consolidado.porAtributo : [];
  for (const a of porAtrib) {
    if (a?.cumplido === false) {
      (isCritical(a) ? afectCrit : afectNoCrit).push(a.atributo || a.nombre || '(sin nombre)');
    }
  }
  return {
    callId: audit?.metadata?.callId || '',
    timestamp: audit?.metadata?.timestamp || Date.now(),
    agente: audit?.metadata?.agentName || audit?.analisis?.agent_name || '-',
    cliente: audit?.metadata?.customerName || audit?.analisis?.client_name || '-',
    nota: audit?.consolidado?.notaFinal ?? 0,
    resumen: audit?.analisis?.resumen || '',
    hallazgos: Array.isArray(audit?.analisis?.hallazgos) ? audit.analisis.hallazgos : [],
    sugerencias: Array.isArray(audit?.analisis?.sugerencias_generales) ? audit.analisis.sugerencias_generales : [],
    afectadosNoCriticos: afectNoCrit,
    afectadosCriticos: afectCrit
  };
}

// Calcula resumen grupal del bloque + plan de mejora agregado
function buildGroupSummary(itemsCompact) {
  const total = itemsCompact.length || 0;
  const promedio = total ? Math.round(itemsCompact.reduce((acc, it) => acc + toNum(it.nota), 0) / total) : 0;

  // Top hallazgos/sugerencias
  const hallFreq = new Map();
  const sugFreq  = new Map();
  const critMap  = new Map();
  const noCritMap= new Map();

  for (const it of itemsCompact) {
    (it.hallazgos || []).forEach(h => hallFreq.set(h, (hallFreq.get(h) || 0) + 1));
    (it.sugerencias || []).forEach(s => sugFreq.set(s, (sugFreq.get(s) || 0) + 1));
    (it.afectadosCriticos || []).forEach(a => critMap.set(a, (critMap.get(a) || 0) + 1));
    (it.afectadosNoCriticos || []).forEach(a => noCritMap.set(a, (noCritMap.get(a) || 0) + 1));
  }

  const top = (m, n = 10) => Array.from(m.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`);

  const topHallazgos   = top(hallFreq, 10);
  const topSugerencias = top(sugFreq, 10);
  const topCriticos    = top(critMap, 10);
  const topNoCriticos  = top(noCritMap, 10);

  const resumenGrupo = [
    `Se auditaron ${total} llamadas.`,
    `La nota promedio del bloque fue ${promedio}/100.`,
    topCriticos.length
      ? `Atributos críticos más afectados: ${topCriticos.slice(0, 5).join(', ')}.`
      : `Sin atributos críticos recurrentes.`,
  ].join(' ');

  const planMejora = [
    (topSugerencias.length ? `Refuerzo general sugerido: ${topSugerencias.slice(0,5).join(' · ')}.` : ''),
    (topCriticos.length ? `Enfoque inmediato en atributos críticos: ${topCriticos.slice(0,5).join(', ')}.` : ''),
  ].filter(Boolean).join('\n');

  return {
    total,
    promedio,
    resumen: resumenGrupo,
    topHallazgos,
    atributosCriticos: topCriticos.map(s => s.replace(/\s+\(\d+\)$/, '')),
    atributosNoCriticos: topNoCriticos.map(s => s.replace(/\s+\(\d+\)$/, '')),
    planMejora
  };
}

// Construye el Markdown del bloque (para /reports/batches/<jobId>.md)
function buildBatchMarkdown(jobId, group, itemsCompact) {
  const lines = [];
  lines.push(`# Informe de Bloque — ${jobId}`);
  lines.push('');
  lines.push(`**Total llamadas:** ${group.total}  `);
  lines.push(`**Promedio:** ${group.promedio}/100  `);
  lines.push('');
  lines.push(`## Resumen del Bloque`);
  lines.push(group.resumen || '—');
  lines.push('');
  if (group.planMejora) {
    lines.push('## Plan de Mejora Propuesto');
    lines.push(group.planMejora);
    lines.push('');
  }
  if ((group.topHallazgos || []).length) {
    lines.push('## Hallazgos Recurrentes (Top)');
    for (const h of group.topHallazgos) lines.push(`- ${h}`);
    lines.push('');
  }
  if ((group.atributosCriticos || []).length) {
    lines.push('## Atributos Críticos más afectados');
    for (const a of group.atributosCriticos) lines.push(`- ${a}`);
    lines.push('');
  }
  if ((group.atributosNoCriticos || []).length) {
    lines.push('## Atributos No Críticos más afectados');
    for (const a of group.atributosNoCriticos) lines.push(`- ${a}`);
    lines.push('');
  }
  lines.push('## Detalle por Llamada (resumen breve)');
  for (const it of itemsCompact) {
    const fecha = it.timestamp ? new Date(it.timestamp).toLocaleString() : '';
    lines.push(`### ${it.callId || '(sin id)'} — Nota ${toNum(it.nota)}/100`);
    lines.push(`**Fecha:** ${fecha}  `);
    lines.push(`**Agente:** ${it.agente || '-'}  `);
    lines.push(`**Cliente:** ${it.cliente || '-'}  `);
    if (it.resumen) {
      lines.push('');
      lines.push(it.resumen);
      lines.push('');
    }
    if ((it.hallazgos || []).length) {
      lines.push('**Hallazgos:**');
      for (const h of it.hallazgos) lines.push(`- ${h}`);
      lines.push('');
    }
    const nc = (it.afectadosNoCriticos || []).join(', ');
    const c  = (it.afectadosCriticos || []).join(', ');
    lines.push(`**Afectados no críticos:** ${nc || '—'}`);
    lines.push(`**Afectados críticos:** ${c || '—'}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- POST /batch/start
router.post('/batch/start', upload.fields([
  { name: 'matrix', maxCount: 1 },
  { name: 'audios', maxCount: Number(process.env.BATCH_MAX_FILES || 2000) }
]), async (req, res) => {
  try {
    if (!req.files?.matrix?.[0] || !req.files?.audios?.length) {
      return res.status(400).json({ error: 'Adjunta "matrix" (.xlsx) y al menos un archivo en "audios"' });
    }

    // 1) Parse matriz
    const matrixBuf = req.files.matrix[0].buffer;
    const matrix = parseMatrixFromXlsx(matrixBuf);
    if (!Array.isArray(matrix) || matrix.length === 0) {
      return res.status(422).json({ error: 'Matriz inválida o vacía' });
    }

    // 2) Crear job
    const jobId = makeJobId();
    const job = {
      id: jobId,
      status: 'queued',
      total: req.files.audios.length,
      done: 0,
      items: req.files.audios.map(f => ({ name: f.originalname, status: 'pending' })),
      em: new EventEmitter(),
      group: null
    };
    jobs.set(jobId, job);

    // 3) Responder de una vez con el jobId (frontend abrirá el SSE)
    res.json({ jobId });

    // 4) Procesamiento en background
    setImmediate(async () => {
      job.status = 'running';
      notify(job);

      const language     = String(req.body.language || 'es-ES');
      const channel      = String(req.body.channel  || 'voz');
      const provider     = String(req.body.provider || '').trim().toLowerCase();
      const mode         = String(req.body.mode || '').trim().toLowerCase();
      const agentChannel = Number.isFinite(Number(req.body.agentChannel)) ? Number(req.body.agentChannel) : undefined;
      const metodologia  = String(req.body.metodologia || '');
      const cartera      = String(req.body.cartera || '');

      const analysisPrompt =
        (metodologia === 'cobranza' && cartera === 'carteras_bogota')
          ? 'Analiza la auditoría de la cartera Bogotá con los criterios y etapas definidos para gestión jurídica y extrajudicial.'
          : (metodologia === 'cobranza' && cartera === 'carteras_medellin')
            ? 'Analiza la auditoría de la cartera Medellín siguiendo los lineamientos de negociación, objeciones y formalidad en canales.'
            : '';

      const compactList = [];

      for (let i = 0; i < req.files.audios.length; i++) {
        const f = req.files.audios[i];
        try {
          // a) Transcribir
          const transcript = await transcribeAudio(
            f.buffer,
            f.originalname,
            language,
            { provider, mode, agentChannel }
          );

          // b) Analizar
          const analysis = await analyzeTranscriptWithMatrix({
            transcript,
            matrix,
            prompt: analysisPrompt,
            context: { metodologia, cartera }
          });

          // c) Scoring
          const scoring = scoreFromMatrix(analysis, matrix);

          // d) Persistir
          const callId = `${Date.now()}_${i + 1}`;
          const agentName    = cleanName(analysis?.agent_name || '');
          const customerName = cleanName(analysis?.client_name || '');
          const audit = {
            metadata: {
              callId,
              agentName:    agentName || '-',
              customerName: customerName || '-',
              language,
              channel,
              provider: provider || '(default .env)',
              metodologia,
              cartera,
              timestamp: Date.now()
            },
            transcript,
            analisis: {
              ...analysis,
              agent_name: agentName || '',
              client_name: customerName || ''
            },
            consolidado: scoring
          };
          saveAudit(audit);

          // e) compact para front
          const compact = compactAuditForFront(audit);
          job.items[i] = { name: f.originalname, status: 'done', callId, meta: compact };
          compactList.push(compact);

          job.done += 1;
          notify(job);
        } catch (err) {
          job.items[i] = { name: f.originalname, status: 'error', error: err?.message || String(err) };
          job.done += 1;
          notify(job);
        }
      }

      // Resumen grupal + Reporte de bloque
      job.group = buildGroupSummary(compactList);
      try {
        ensureDir(REPORTS_BATCH_DIR);
        const md = buildBatchMarkdown(job.id, job.group, compactList);
        fs.writeFileSync(path.join(REPORTS_BATCH_DIR, `${job.id}.md`), md, 'utf-8');
      } catch (e) {
        console.warn('[BATCH][report][WARN]', e?.message || e);
      }

      job.status = 'done';
      notify(job);
    });
  } catch (e) {
    console.error('[BATCH][start][ERROR]', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---- SSE /batch/progress/:jobId
router.get('/batch/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders?.();

  const send = (data) => {
    res.write(`event: progress\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!job) {
    send({ status: 'error', total: 0, done: 0, items: [], error: 'job not found' });
    return res.end();
  }

  send(payload(job));

  const onProgress = (data) => send(data);
  job.em.on('progress', onProgress);

  req.on('close', () => {
    job.em.off('progress', onProgress);
    res.end();
  });
});

// ---- Resultado compacto del lote (para pintar UI final)
router.get('/batch/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const items = (job.items || []).map(it => ({
    name: it.name,
    status: it.status,
    callId: it.callId || null,
    meta: it.meta || null
  }));

  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    done: job.done,
    items,
    group: job.group || null
  });
});

export default router;
