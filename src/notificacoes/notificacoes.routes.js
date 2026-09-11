const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');

const router = express.Router();

// minhas notificações (mais novas primeiro) + contagem de não-lidas
router.get('/notificacoes', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.tipo, n.ref_id, n.dados, n.lida, n.criado_em,
              a.handle AS ator_handle, a.nome AS ator_nome, a.exposicao AS ator_exposicao, a.is_sud0 AS ator_sud0
         FROM notificacoes n
         LEFT JOIN contas a ON a.id = n.ator_id
        WHERE n.destinatario_id = $1
        ORDER BY n.criado_em DESC
        LIMIT 40`, [req.user.id]);
    const nao = await pool.query(
      `SELECT count(*)::int AS n FROM notificacoes WHERE destinatario_id = $1 AND lida = false`, [req.user.id]);
    res.json({ ok: true, nao_lidas: nao.rows[0].n, notificacoes: rows.map((r) => ({
      id: r.id, tipo: r.tipo, ref_id: r.ref_id, dados: r.dados, lida: r.lida, criado_em: r.criado_em,
      ator_handle: r.ator_sud0 ? null : r.ator_handle,
      ator_nome: (r.ator_sud0 || r.ator_exposicao !== 'aberto') ? null : r.ator_nome,
      ator_sud0: !!r.ator_sud0,
    })) });
  } catch (e) { next(e); }
});

// marcar todas como lidas
router.post('/notificacoes/lidas', requerLogin, async (req, res, next) => {
  try {
    await pool.query(`UPDATE notificacoes SET lida = true WHERE destinatario_id = $1 AND lida = false`, [req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// marcar uma como lida
router.post('/notificacoes/:id/lida', requerLogin, async (req, res, next) => {
  try {
    await pool.query(`UPDATE notificacoes SET lida = true WHERE id = $1 AND destinatario_id = $2`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
