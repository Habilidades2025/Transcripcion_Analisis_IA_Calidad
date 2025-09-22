import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;
import os from 'os';
import process from 'process';

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    node: process.version,
    platform: os.platform(),
    uptime: process.uptime()
  });
});

export default router;
