// src/index.js
import dotenvPkg from 'dotenv';
const dotenv = dotenvPkg.default ?? dotenvPkg;
dotenv.config();

import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;

import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// Routers
import healthRouter     from './routes/health.route.js';
import transcribeRouter from './routes/transcribe.route.js';
import analyzeRouter    from './routes/analyze.route.js';
import auditsRouter     from './routes/audits.route.js';
import diagRouter       from './routes/diag.route.js';
import batchRouter      from './routes/batch.route.js'; // export default

// --- Utilidades de ruta (ESM) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --- Crear app ANTES de usarla ---
const app = express();

// --- Middlewares base ---
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// --- UI estática ---
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Rutas API ---
app.use('/', healthRouter);
app.use('/', transcribeRouter);
app.use('/', analyzeRouter);
app.use('/', auditsRouter);
app.use('/', diagRouter);
app.use('/', batchRouter); // expone /batch/start y /batch/progress/:jobId

// --- Arranque con fallback de puerto ---
function start(port, attemptsLeft = 3) {
  const server = app.listen(port, () => {
    console.log(`API escuchando en http://127.0.0.1:${port}`);
  });

  // Evita timeouts en cargas pesadas (batch)
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`Puerto ${port} en uso. Probando ${port + 1}...`);
      setTimeout(() => start(port + 1, attemptsLeft - 1), 250);
    } else {
      console.error('No se pudo iniciar el servidor:', err);
      process.exit(1);
    }
  });
}

const PORT = Number(process.env.PORT) || 3000;
start(PORT);
