const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const svc = require('./auth.service');

const router = express.Router();

// limite anti força-bruta no login
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

router.post('/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ erro: 'dados_incompletos' });
    const r = await svc.login(pool, email, senha);
    if (!r.ok) return res.status(401).json({ erro: 'credenciais_invalidas' });
    res.json({ token: r.token, conta: r.conta });
  } catch (e) { next(e); }
});

// quem sou eu (a partir do token)
router.get('/auth/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ erro: 'nao_autenticado' });
  res.json({ conta: req.user });
});

module.exports = router;
