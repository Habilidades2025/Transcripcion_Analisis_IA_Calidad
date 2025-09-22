import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;

import multerPkg from 'multer';
const multer = multerPkg.default ?? multerPkg;

import fs from 'fs';
import path from 'path';

import { parseMatrixFromXlsx } from '../services/matrixService.js';
import { transcribeAudio } from '../services/transcriptionService.js';
import { analyzeTranscriptWithMatrix } from '../services/analysisService.js';
import { scoreFromMatrix } from '../services/scoringService.js';
import { saveAudit } from '../services/persistService.js';
import { extractNames } from '../services/nameExtractor.js';

// --- Multer en memoria (100MB por archivo; ajustable por env)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE || 100 * 1024 * 1024) }
});

const router = express.Router();

/** Helper seguro para strings */
function s(v, def = '') { return (v == null ? def : String(v)).trim(); }

router.post(
  '/analyze',
  upload.fields([
    { name: 'matrix', maxCount: 1 },
    { name: 'audio',  maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      // --- Validación mínima
      if (!req.files?.matrix?.[0] || !req.files?.audio?.[0]) {
        return res.status(400).json({
          error: 'Datos incompletos',
          detail: 'Adjunta "matrix" (.xlsx) y "audio" (.mp3/.wav/.m4a)'
        });
      }

      // --- Metadatos del formulario
      const callId       = s(req.body.callId) || String(Date.now());
      const formAgent    = s(req.body.agentName);
      const formClient   = s(req.body.customerName);
      const language     = s(req.body.language || 'es-ES');
      const channel      = s(req.body.channel || 'voz');
      const metodologia  = s(req.body.metodologia);
      const cartera      = s(req.body.cartera);

      // --- Opciones ASR
      const provider     = s(req.body?.provider).toLowerCase(); // 'faster' | 'openai'
      const mode         = s(req.body?.mode).toLowerCase();     // 'mono' | 'stereo'
      const agentChannel = Number.isFinite(Number(req.body?.agentChannel))
        ? Number(req.body.agentChannel)
        : undefined;

      // --- 1) Matriz
      const matrixBuf = req.files.matrix[0].buffer;
      const matrix = parseMatrixFromXlsx(matrixBuf);
      if (!Array.isArray(matrix) || matrix.length === 0) {
        return res.status(422).json({
          error: 'Matriz inválida',
          detail: 'No se extrajeron filas válidas (Atributo, Categoria, Peso)'
        });
      }

      // --- 2) Transcripción
      const audioFile = req.files.audio[0];
      let transcript = s(req.body.transcript);
      if (!transcript) {
        transcript = await transcribeAudio(
          audioFile.buffer,
          audioFile.originalname,
          language,
          { provider, mode, agentChannel }
        );
      }

      // --- 3) Prompt por campaña (breve y específico)
      let analysisPrompt = '';
      if (metodologia === 'cobranza') {
        if (cartera === 'carteras_bogota') {
          analysisPrompt =
            'Analiza la auditoría de la cartera Bogotá con criterios de gestión jurídica/extrajudicial, negociación clara, objeciones frecuentes y cierre formal.';
        } else if (cartera === 'carteras_medellin') {
          analysisPrompt =
            'Analiza la auditoría de la cartera Medellín considerando formalidad, perfilamiento, alternativas de pago y manejo de objeciones.';
        }
      }

      // --- 4) Análisis LLM (prompt + contexto viajan en la MISMA request)
      const analysis = await analyzeTranscriptWithMatrix({
        transcript,
        matrix,
        prompt: analysisPrompt,
        context: { metodologia, cartera }
      });

      // (Opcional) si en analysis añadiste estos campos, se priorizan cuando falten en el form
      const llmAgent  = typeof analysis?.agent_name  === 'string' ? analysis.agent_name.trim()  : '';
      const llmClient = typeof analysis?.client_name === 'string' ? analysis.client_name.trim() : '';

      // --- 5) Resolución robusta de nombres (form -> analysis -> heurística/LLM auxiliar)
      let finalAgentName    = formAgent  || llmAgent;
      let finalCustomerName = formClient || llmClient;

      if (!finalAgentName || !finalCustomerName) {
        try {
          const guessed = await extractNames({ summary: analysis?.resumen || '', transcript });
          if (!finalAgentName && guessed.agent)     finalAgentName    = guessed.agent;
          if (!finalCustomerName && guessed.client) finalCustomerName = guessed.client;
        } catch (e) {
          if (process.env.DEBUG_NAME === '1') {
            console.warn('[analyze.route][names][WARN]', e?.message || e);
          }
        }
      }

      // Defaults visuales
      if (!finalAgentName)    finalAgentName    = '-';
      if (!finalCustomerName) finalCustomerName = '-';

      // --- 6) Scoring
      const scoring = scoreFromMatrix(analysis, matrix);

      // --- 7) Reporte .md (para link "MD" en el consolidado)
      const reportDir = path.resolve('reports');
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

      const reportPath = path.join(reportDir, `${callId}.md`);
      const md = [
        `# Informe de Calidad — ${callId}`,
        '',
        `**Agente:** ${finalAgentName}`,
        `**Cliente:** ${finalCustomerName}`,
        `**Idioma:** ${language}`,
        `**Canal:** ${channel}`,
        `**Proveedor ASR:** ${provider || '(default .env)'}`,
        `**Nota Final:** ${scoring.notaFinal}/100`,
        '',
        '## Resumen',
        analysis?.resumen || '(sin resumen)',
        '',
        '## Hallazgos',
        (analysis?.hallazgos || []).map(h => `- ${h}`).join('\n') || '- (sin hallazgos)',
        '',
        '## Atributos',
        (scoring?.porAtributo || [])
          .map(a => `- ${a.atributo} (${a.cumplido ? '✅' : '❌'}) peso ${a.peso}${a.mejora ? ' | Mejora: ' + a.mejora : ''}`)
          .join('\n') || '- (sin atributos procesados)'
      ].join('\n');
      fs.writeFileSync(reportPath, md, 'utf-8');

      // --- 8) Persistencia (saveAudit shardea e indexa incrementalmente)
      const audit = {
        metadata: {
          callId,
          agentName:    finalAgentName,
          customerName: finalCustomerName,
          language,
          channel,
          provider: provider || '(default .env)',
          metodologia,
          cartera,
          timestamp: Date.now()
        },
        transcript,
        analisis: analysis,
        consolidado: scoring,
        reportPath // se mantiene para compat con /audits/files/:name
      };

      const savedPath = saveAudit(audit);

      // --- 9) Respuesta (shape estable para el front actual)
      return res.json({ ...audit, savedPath });
    } catch (err) {
      console.error('[ANALYZE][ERROR]', err);
      return res.status(500).json({
        error: 'Error interno',
        detail: err?.message || String(err),
        hint: 'Revisa .env (API key / FW_SERVER_URL), formatos de archivos y conectividad'
      });
    }
  }
);

export default router;
