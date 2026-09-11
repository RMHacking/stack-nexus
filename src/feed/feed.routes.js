// StackFeed — publicar, listar, editar, apagar e fixar posts.
const express = require('express');
const { pool } = require('../db');
const { requerLogin, requerSud0 } = require('../auth/middleware');
const { notificar } = require('../notificacoes/notif.service');

const router = express.Router();

// publicar um post (máx 500 caracteres)
router.post('/posts', requerLogin, async (req, res, next) => {
  try {
    const corpo = ((req.body && req.body.corpo) || '').trim();
    const imagem = (req.body && req.body.imagem) ? String(req.body.imagem) : null;
    if (!corpo && !imagem) return res.status(400).json({ erro: 'vazio' });
    if (corpo.length > 500) return res.status(400).json({ erro: 'muito_longo' });
    if (imagem && imagem.length > 1500000) return res.status(413).json({ ok: false, erro: 'imagem_grande' });
    const { rows } = await pool.query(
      `INSERT INTO posts (autor_id, corpo, imagem) VALUES ($1, $2, $3)
       RETURNING id, corpo, criado_em`,
      [req.user.id, corpo, imagem]
    );
    res.json({ ok: true, post: rows[0] });
  } catch (e) { next(e); }
});

// editar o próprio post
router.patch('/posts/:id', requerLogin, async (req, res, next) => {
  try {
    const corpo = ((req.body && req.body.corpo) || '').trim();
    if (!corpo) return res.status(400).json({ erro: 'vazio' });
    if (corpo.length > 500) return res.status(400).json({ erro: 'muito_longo' });
    const { rows } = await pool.query(
      `UPDATE posts SET corpo = $1, editado_em = now()
        WHERE id = $2 AND autor_id = $3
        RETURNING id`,
      [corpo, req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ ok: false, motivo: 'nao_e_seu' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// apagar: o autor apaga o próprio; o sud0 apaga qualquer um (moderação)
router.delete('/posts/:id', requerLogin, async (req, res, next) => {
  try {
    const sql = req.user.is_sud0
      ? `DELETE FROM posts WHERE id = $1 RETURNING id`
      : `DELETE FROM posts WHERE id = $1 AND autor_id = $2 RETURNING id`;
    const params = req.user.is_sud0 ? [req.params.id] : [req.params.id, req.user.id];
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(403).json({ ok: false, motivo: 'nao_permitido' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// fixar/desafixar um comunicado (só sud0)
router.post('/posts/:id/fixar', requerSud0, async (req, res, next) => {
  try {
    const fixar = !!(req.body && req.body.fixar);
    const { rows } = await pool.query(
      `UPDATE posts SET fixado = $1 WHERE id = $2 RETURNING id, fixado`,
      [fixar, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false });
    res.json({ ok: true, fixado: rows[0].fixado });
  } catch (e) { next(e); }
});

// feed: fixados no topo, depois por recência. Marca o que é seu e o que é editado.
router.get('/feed', requerLogin, async (req, res, next) => {
  try {
    // evento que já passou do último dia: desafixa (o post continua no feed, com o chat)
    try { await pool.query("UPDATE posts SET fixado=false WHERE tipo='evento_novo' AND fixado=true AND ref_id IN (SELECT id FROM eventos WHERE fim IS NOT NULL AND CURRENT_DATE > fim)"); } catch (_e) { /* best-effort */ }
    const { rows } = await pool.query(
      `SELECT p.id, p.corpo, p.imagem, p.criado_em, p.editado_em, p.fixado, p.tipo, p.ref_id, p.autor_id,
              c.handle, c.nome, c.exposicao, c.trilha, c.is_sud0, c.membro_num,
              rx.rocket, rx.brain, rx.bolt, rx.minha,
              (SELECT count(*)::int FROM post_comentarios pc WHERE pc.post_id = p.id) AS n_com,
              (SELECT COALESCE(json_agg(t ORDER BY t.criado_em), '[]'::json) FROM (
                 SELECT pc.corpo, pc.criado_em, c2.handle,
                        (CASE WHEN c2.exposicao = 'aberto' THEN c2.nome ELSE NULL END) AS nome, c2.is_sud0
                   FROM post_comentarios pc JOIN contas c2 ON c2.id = pc.autor_id
                  WHERE pc.post_id = p.id
                  ORDER BY pc.criado_em DESC LIMIT 2
               ) t) AS ultimas_com
         FROM posts p JOIN contas c ON c.id = p.autor_id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE tipo='rocket')::int AS rocket,
                  count(*) FILTER (WHERE tipo='brain')::int  AS brain,
                  count(*) FILTER (WHERE tipo='bolt')::int   AS bolt,
                  max(tipo) FILTER (WHERE autor_id = $1)     AS minha
             FROM reacoes r WHERE r.alvo_tipo='post' AND r.alvo_id = p.id
         ) rx ON true
        ORDER BY p.fixado DESC, p.criado_em DESC LIMIT 100`, [req.user.id]
    );
    const feed = rows.map((r) => ({
      id: r.id, corpo: r.corpo, imagem: r.imagem, criado_em: r.criado_em,
      fixado: r.fixado, editado: !!r.editado_em, tipo: r.tipo, ref_id: r.ref_id,
      meu: r.autor_id === req.user.id,
      rx: { rocket: r.rocket || 0, brain: r.brain || 0, bolt: r.bolt || 0, minha: r.minha || null },
      coment: r.n_com || 0,
      ultimas: r.ultimas_com || [],
      autor: {
        handle: r.handle,
        nome: r.exposicao === 'aberto' ? r.nome : null,
        trilha: r.trilha, is_sud0: r.is_sud0, membro_num: r.membro_num,
      },
    }));
    res.json(feed);
  } catch (e) { next(e); }
});

// ===== comentários (chat) dos posts do feed =====
router.get('/posts/:id/comentarios', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pc.id, pc.corpo, pc.criado_em, pc.autor_id, pc.parent_id,
              c.handle, c.nome, c.exposicao, c.is_sud0,
              COALESCE(rb.n,0) AS curtidas, (rb.eu IS NOT NULL) AS eu_curti
         FROM post_comentarios pc
         JOIN contas c ON c.id = pc.autor_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS n, max(CASE WHEN r.autor_id = $2 THEN 1 END) AS eu
             FROM reacoes r WHERE r.alvo_tipo='comentario' AND r.alvo_id = pc.id AND r.tipo='bolt'
         ) rb ON true
        WHERE pc.post_id = $1
        ORDER BY pc.criado_em ASC LIMIT 400`, [req.params.id, req.user.id]);
    res.json({ ok: true, comentarios: rows.map((r) => ({
      id: r.id, corpo: r.corpo, criado_em: r.criado_em, parent_id: r.parent_id,
      handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null,
      is_sud0: r.is_sud0, meu: r.autor_id === req.user.id,
      curtidas: r.curtidas || 0, eu_curti: !!r.eu_curti,
    })) });
  } catch (e) { next(e); }
});
router.post('/posts/:id/comentarios', requerLogin, async (req, res, next) => {
  try {
    const corpo = String((req.body || {}).corpo || '').trim();
    if (!corpo) return res.status(400).json({ ok: false, erro: 'vazio' });
    if (corpo.length > 500) return res.status(400).json({ ok: false, erro: 'longo' });
    const ex = await pool.query('SELECT id, autor_id FROM posts WHERE id = $1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ ok: false });
    // resposta? valida o pai e normaliza pra 1 nivel (a raiz do fio)
    let parentId = (req.body && req.body.parent_id) ? String(req.body.parent_id) : null;
    let respondido = null; // autor do comentario respondido (pra notificar)
    if (parentId) {
      const pp = await pool.query('SELECT id, parent_id, autor_id FROM post_comentarios WHERE id = $1 AND post_id = $2', [parentId, req.params.id]);
      if (!pp.rows.length) { parentId = null; }
      else { respondido = pp.rows[0].autor_id; if (pp.rows[0].parent_id) parentId = pp.rows[0].parent_id; }
    }
    const ins = await pool.query(
      `INSERT INTO post_comentarios (post_id, autor_id, corpo, parent_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.params.id, req.user.id, corpo, parentId]);
    const donoId = ex.rows[0].autor_id;
    if (parentId) {
      // resposta: avisa quem foi respondido + o dono do post
      await notificar(pool, { destinatario_id: respondido, ator_id: req.user.id, tipo: 'resposta', ref_id: req.params.id });
      if (String(donoId) !== String(respondido))
        await notificar(pool, { destinatario_id: donoId, ator_id: req.user.id, tipo: 'comentario', ref_id: req.params.id });
    } else {
      // comentario de topo: dono + demais participantes
      await notificar(pool, { destinatario_id: donoId, ator_id: req.user.id, tipo: 'comentario', ref_id: req.params.id });
      const parts = await pool.query(
        `SELECT DISTINCT autor_id FROM post_comentarios WHERE post_id=$1 AND parent_id IS NULL AND autor_id<>$2 AND autor_id<>$3`,
        [req.params.id, req.user.id, donoId]);
      for (const row of parts.rows) {
        await notificar(pool, { destinatario_id: row.autor_id, ator_id: req.user.id, tipo: 'comentario_thread', ref_id: req.params.id });
      }
    }
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { console.error('[coment]', e); res.status(500).json({ ok:false, erro:'srv', detalhe:String(e.code||'')+' '+String(e.message||'').slice(0,120) }); }
});
router.delete('/posts/:id/comentarios/:cid', requerLogin, async (req, res, next) => {
  try {
    const sql = req.user.is_sud0
      ? 'DELETE FROM post_comentarios WHERE id = $1 AND post_id = $2 RETURNING id'
      : 'DELETE FROM post_comentarios WHERE id = $1 AND post_id = $2 AND autor_id = $3 RETURNING id';
    const params = req.user.is_sud0 ? [req.params.cid, req.params.id] : [req.params.cid, req.params.id, req.user.id];
    const del = await pool.query(sql, params);
    res.json({ ok: del.rows.length > 0 });
  } catch (e) { next(e); }
});

module.exports = router;
