const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');

const router = express.Router();

// nº de conexões aceitas de uma conta
async function contarConexoes(contaId) {
  const q = await pool.query(
    `SELECT count(*)::int AS n FROM conexoes
      WHERE status='aceita' AND (de_id=$1 OR para_id=$1)`, [contaId]);
  return q.rows[0].n;
}

// estado da relação entre "eu" e "alvo": nenhum | enviado | recebido | conectado
async function estadoEntre(meuId, alvoId) {
  const q = await pool.query(
    `SELECT de_id, para_id, status FROM conexoes
      WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1)
      LIMIT 1`, [meuId, alvoId]);
  if (!q.rows.length) return 'nenhum';
  const r = q.rows[0];
  if (r.status === 'aceita') return 'conectado';
  return r.de_id === meuId ? 'enviado' : 'recebido';
}

// resolve um @handle -> conta real (não sud0, não eu)
async function acharAlvo(handle, meuId) {
  const h = String(handle || '').replace(/^@/, '');
  const q = await pool.query(
    `SELECT id, handle, nome, exposicao, foto_url, is_sud0 FROM contas WHERE lower(handle)=lower($1)`, [h]);
  if (!q.rows.length) return { erro: 'nao_encontrado' };
  const a = q.rows[0];
  if (a.is_sud0) return { erro: 'sud0' };
  if (a.id === meuId) return { erro: 'voce_mesmo' };
  return { conta: a };
}

// ---- pedir conexão (auto-aceita se o outro já tinha pedido) ----
router.post('/conexoes/:handle', requerLogin, async (req, res, next) => {
  try {
    const r = await acharAlvo(req.params.handle, req.user.id);
    if (r.erro) return res.status(400).json({ ok: false, erro: r.erro });
    const alvo = r.conta;
    const ex = await pool.query(
      `SELECT de_id, para_id, status FROM conexoes
        WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1) LIMIT 1`,
      [req.user.id, alvo.id]);
    if (ex.rows.length) {
      const e = ex.rows[0];
      if (e.status === 'aceita') return res.json({ ok: true, estado: 'conectado' });
      if (e.de_id === req.user.id) return res.json({ ok: true, estado: 'enviado' });
      // o outro já tinha me pedido -> aceita
      await pool.query(`UPDATE conexoes SET status='aceita' WHERE de_id=$1 AND para_id=$2`, [alvo.id, req.user.id]);
      return res.json({ ok: true, estado: 'conectado' });
    }
    await pool.query(`INSERT INTO conexoes (de_id, para_id, status) VALUES ($1,$2,'pendente')`, [req.user.id, alvo.id]);
    res.json({ ok: true, estado: 'enviado' });
  } catch (e) { console.error('[conexoes/pedir]', e); res.status(500).json({ ok:false, erro:'srv', detalhe:String(e.code||'')+' '+String(e.message||'').slice(0,120) }); }
});

// ---- aceitar um pedido recebido ----
router.post('/conexoes/:handle/aceitar', requerLogin, async (req, res, next) => {
  try {
    const r = await acharAlvo(req.params.handle, req.user.id);
    if (r.erro) return res.status(400).json({ ok: false, erro: r.erro });
    const upd = await pool.query(
      `UPDATE conexoes SET status='aceita'
        WHERE de_id=$1 AND para_id=$2 AND status='pendente' RETURNING de_id`,
      [r.conta.id, req.user.id]);
    if (!upd.rowCount) return res.status(404).json({ ok: false, erro: 'sem_pedido' });
    res.json({ ok: true, estado: 'conectado' });
  } catch (e) { next(e); }
});

// ---- remover: cancela pedido enviado, recusa recebido ou desfaz conexão ----
router.delete('/conexoes/:handle', requerLogin, async (req, res, next) => {
  try {
    const r = await acharAlvo(req.params.handle, req.user.id);
    if (r.erro) return res.status(400).json({ ok: false, erro: r.erro });
    await pool.query(
      `DELETE FROM conexoes WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1)`,
      [req.user.id, r.conta.id]);
    res.json({ ok: true, estado: 'nenhum' });
  } catch (e) { next(e); }
});

// ---- estado da relação com uma pessoa (+ nº de conexões dela) ----
router.get('/conexoes/status/:handle', requerLogin, async (req, res, next) => {
  try {
    const r = await acharAlvo(req.params.handle, req.user.id);
    if (r.erro) return res.status(400).json({ ok: false, erro: r.erro });
    const estado = await estadoEntre(req.user.id, r.conta.id);
    res.json({ ok: true, estado, conexoes: await contarConexoes(r.conta.id) });
  } catch (e) { next(e); }
});

// ---- pedidos recebidos (para a coluna direita) ----
router.get('/conexoes/pedidos', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT co.criado_em, c.handle, c.nome, c.exposicao, c.foto_url, c.trilha, c.membro_num
         FROM conexoes co JOIN contas c ON c.id = co.de_id
        WHERE co.para_id=$1 AND co.status='pendente'
        ORDER BY co.criado_em DESC LIMIT 20`, [req.user.id]);
    res.json({ ok: true, pedidos: rows.map((r) => ({
      handle: r.handle,
      nome: r.exposicao === 'aberto' ? r.nome : null,
      foto_url: r.exposicao === 'aberto' ? r.foto_url : null,
      trilha: r.trilha, membro_num: r.membro_num,
    })) });
  } catch (e) { next(e); }
});

// ---- minhas conexões aceitas ----
router.get('/conexoes', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.handle, c.nome, c.exposicao, c.foto_url, c.trilha, c.membro_num, co.criado_em
         FROM conexoes co
         JOIN contas c ON c.id = CASE WHEN co.de_id=$1 THEN co.para_id ELSE co.de_id END
        WHERE co.status='aceita' AND (co.de_id=$1 OR co.para_id=$1)
        ORDER BY co.criado_em DESC`, [req.user.id]);
    res.json({ ok: true, total: rows.length, conexoes: rows.map((r) => ({
      handle: r.handle,
      nome: r.exposicao === 'aberto' ? r.nome : null,
      foto_url: r.exposicao === 'aberto' ? r.foto_url : null,
      trilha: r.trilha, membro_num: r.membro_num,
    })) });
  } catch (e) { next(e); }
});

router.contarConexoes = contarConexoes;
router.estadoEntre = estadoEntre;
module.exports = router;
