// Presenca online — pulso leve: o app avisa "estou aqui" a cada ~40s.
// online = visto_em nos ultimos 90s (tolera um pulso perdido).
const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');

const router = express.Router();

// o app chama isto periodicamente enquanto a aba esta visivel
router.post('/presenca/ping', requerLogin, async (req, res, next) => {
  try {
    await pool.query('UPDATE contas SET visto_em = now() WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
