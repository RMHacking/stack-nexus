// Reações (❤️ heart / 🔥 fire) em posts e projetos. Uma por pessoa por alvo (toggle/troca).
const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');

const router = express.Router();
const ALVOS = ['post', 'projeto', 'comentario'];
const TIPOS = ['rocket', 'brain', 'bolt'];

router.post('/reacoes', requerLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!ALVOS.includes(b.alvo_tipo) || !TIPOS.includes(b.tipo) || !b.alvo_id)
      return res.status(400).json({ ok: false, erro: 'invalido' });
    const ex = await pool.query(
      'SELECT tipo FROM reacoes WHERE alvo_tipo = $1 AND alvo_id = $2 AND autor_id = $3',
      [b.alvo_tipo, b.alvo_id, req.user.id]);
    if (ex.rows.length) {
      if (ex.rows[0].tipo === b.tipo) {
        await pool.query('DELETE FROM reacoes WHERE alvo_tipo=$1 AND alvo_id=$2 AND autor_id=$3', [b.alvo_tipo, b.alvo_id, req.user.id]);
      } else {
        await pool.query('UPDATE reacoes SET tipo=$4, criado_em=now() WHERE alvo_tipo=$1 AND alvo_id=$2 AND autor_id=$3', [b.alvo_tipo, b.alvo_id, req.user.id, b.tipo]);
      }
    } else {
      await pool.query('INSERT INTO reacoes (alvo_tipo, alvo_id, autor_id, tipo) VALUES ($1,$2,$3,$4)', [b.alvo_tipo, b.alvo_id, req.user.id, b.tipo]);
    }
    const c = await pool.query(
      `SELECT count(*) FILTER (WHERE tipo='rocket')::int AS rocket,
              count(*) FILTER (WHERE tipo='brain')::int  AS brain,
              count(*) FILTER (WHERE tipo='bolt')::int   AS bolt,
              max(tipo) FILTER (WHERE autor_id = $3)      AS minha
         FROM reacoes WHERE alvo_tipo=$1 AND alvo_id=$2`, [b.alvo_tipo, b.alvo_id, req.user.id]);
    res.json({ ok: true, rocket: c.rows[0].rocket, brain: c.rows[0].brain, bolt: c.rows[0].bolt, minha: c.rows[0].minha });
  } catch (e) { next(e); }
});

module.exports = router;
