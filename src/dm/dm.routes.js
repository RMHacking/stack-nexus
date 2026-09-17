// StackChat 1-a-1 (DM) — conversas privadas, com bloqueio bidirecional.
const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');
const { notificar } = require('../notificacoes/notif.service');

const router = express.Router();

async function acharConta(handle) {
  const r = await pool.query(
    'SELECT id, handle, nome, exposicao, trilha, is_sud0 FROM contas WHERE lower(handle) = lower($1)', [handle]);
  return r.rows[0] || null;
}
function pub(c) {
  return { handle: c.handle, nome: c.exposicao === 'aberto' ? c.nome : null, trilha: c.trilha, is_sud0: c.is_sud0 };
}
async function bloqueioEntre(a, b) {
  const r = await pool.query(
    `SELECT bloqueador_id FROM dm_bloqueios
      WHERE (bloqueador_id = $1 AND bloqueado_id = $2) OR (bloqueador_id = $2 AND bloqueado_id = $1)`, [a, b]);
  let eu_bloqueei = false, me_bloqueou = false;
  r.rows.forEach((x) => { if (x.bloqueador_id === a) eu_bloqueei = true; else me_bloqueou = true; });
  return { eu_bloqueei, me_bloqueou };
}
// Fundador anonimo: membro comum NAO inicia DM com o sud0.
// So pode enviar se o proprio sud0 ja abriu a conversa (ai o membro responde).
// Trava no servidor (unico ponto onde a msg e criada) — o cliente esconde, o servidor decide.
async function fundadorNaoRecebeInicio(remetenteId, remetenteIsSud0, outro) {
  if (!outro || !outro.is_sud0 || remetenteIsSud0) return false;
  const r = await pool.query(
    'SELECT 1 FROM dm_mensagens WHERE de_id = $1 AND para_id = $2 LIMIT 1', [outro.id, remetenteId]);
  return r.rows.length === 0; // bloqueia se o fundador ainda nao mandou nada
}

// lista de conversas (quem eu já troquei mensagem) + última msg + não lidas
router.get('/dm', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.handle, c.nome, c.exposicao, c.trilha, c.is_sud0,
              (c.visto_em > now() - interval '90 seconds') AS online,
              lm.corpo AS ultima, lm.criado_em AS ultima_em,
              (SELECT count(*)::int FROM dm_mensagens x WHERE x.de_id = c.id AND x.para_id = $1 AND x.lida = false) AS nao_lidas
         FROM (
           SELECT CASE WHEN de_id = $1 THEN para_id ELSE de_id END AS outro, max(criado_em) AS ult
             FROM dm_mensagens WHERE de_id = $1 OR para_id = $1 GROUP BY outro
         ) t
         JOIN contas c ON c.id = t.outro
         JOIN LATERAL (
           SELECT corpo, criado_em FROM dm_mensagens m
            WHERE (m.de_id = $1 AND m.para_id = c.id) OR (m.de_id = c.id AND m.para_id = $1)
            ORDER BY criado_em DESC LIMIT 1
         ) lm ON true
        ORDER BY t.ult DESC LIMIT 100`, [req.user.id]);
    const conversas = rows.map((r) => ({
      handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null, trilha: r.trilha, is_sud0: r.is_sud0,
      online: !!r.online,
      ultima: r.ultima, ultima_em: r.ultima_em, nao_lidas: r.nao_lidas,
    }));
    res.json({ ok: true, conversas });
  } catch (e) { next(e); }
});

// histórico com uma pessoa (marca minhas não-lidas dela como lidas)
router.get('/dm/:handle', requerLogin, async (req, res, next) => {
  try {
    const outro = await acharConta(req.params.handle);
    if (!outro) return res.status(404).json({ ok: false });
    if (outro.id === req.user.id) return res.status(400).json({ ok: false, motivo: 'voce_mesmo' });
    await pool.query('UPDATE dm_mensagens SET lida = true WHERE de_id = $1 AND para_id = $2 AND lida = false', [outro.id, req.user.id]);
    const { rows } = await pool.query(
      `SELECT id, de_id, corpo, criado_em FROM dm_mensagens
        WHERE (de_id = $1 AND para_id = $2) OR (de_id = $2 AND para_id = $1)
        ORDER BY criado_em ASC LIMIT 500`, [req.user.id, outro.id]);
    const mensagens = rows.map((r) => ({ id: r.id, corpo: r.corpo, meu: r.de_id === req.user.id, criado_em: r.criado_em }));
    res.json({ ok: true, outro: pub(outro), bloqueio: await bloqueioEntre(req.user.id, outro.id), mensagens });
  } catch (e) { next(e); }
});

// enviar DM (barra se qualquer lado bloqueou)
router.post('/dm/:handle', requerLogin, async (req, res, next) => {
  try {
    const corpo = ((req.body && req.body.corpo) || '').trim();
    if (!corpo) return res.status(400).json({ ok: false, erro: 'vazio' });
    if (corpo.length > 1000) return res.status(400).json({ ok: false, erro: 'muito_longo' });
    const outro = await acharConta(req.params.handle);
    if (!outro) return res.status(404).json({ ok: false });
    if (outro.id === req.user.id) return res.status(400).json({ ok: false, motivo: 'voce_mesmo' });
    if (await fundadorNaoRecebeInicio(req.user.id, req.user.is_sud0, outro))
      return res.status(403).json({ ok: false, motivo: 'fundador', erro: 'O fundador nao recebe mensagens diretas.' });
    const bq = await bloqueioEntre(req.user.id, outro.id);
    if (bq.eu_bloqueei || bq.me_bloqueou) return res.status(403).json({ ok: false, motivo: 'bloqueado' });
    const { rows } = await pool.query(
      `INSERT INTO dm_mensagens (de_id, para_id, corpo) VALUES ($1,$2,$3) RETURNING id`, [req.user.id, outro.id, corpo]);
    notificar(pool, { destinatario_id: outro.id, ator_id: req.user.id, tipo: 'dm' });
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

// apagar UMA mensagem (qualquer um dos dois lados apaga — some pros dois)
router.post('/dm/msg/:mid/apagar', requerLogin, async (req, res) => {
  try {
    const del = await pool.query('DELETE FROM dm_mensagens WHERE id=$1 AND (de_id=$2 OR para_id=$2) RETURNING id', [req.params.mid, req.user.id]);
    if (!del.rowCount) return res.status(404).json({ ok: false });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false }); }
});

// limpar a conversa inteira com alguém
router.post('/dm/:handle/limpar', requerLogin, async (req, res) => {
  try {
    const outro = await acharConta(req.params.handle);
    if (!outro) return res.status(404).json({ ok: false });
    await pool.query('DELETE FROM dm_mensagens WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1)', [req.user.id, outro.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false }); }
});

// bloquear
router.post('/dm/:handle/bloquear', requerLogin, async (req, res, next) => {
  try {
    const outro = await acharConta(req.params.handle);
    if (!outro || outro.id === req.user.id) return res.status(404).json({ ok: false });
    await pool.query('INSERT INTO dm_bloqueios (bloqueador_id, bloqueado_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, outro.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// desbloquear
router.post('/dm/:handle/desbloquear', requerLogin, async (req, res, next) => {
  try {
    const outro = await acharConta(req.params.handle);
    if (!outro) return res.status(404).json({ ok: false });
    await pool.query('DELETE FROM dm_bloqueios WHERE bloqueador_id = $1 AND bloqueado_id = $2', [req.user.id, outro.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
