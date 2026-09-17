// StackProjects — criar, listar, editar e apagar projetos.
// Limite de 5 por pessoa: o SERVIDOR decide (o cliente esconde, o servidor decide).
const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');
const { notificarTodos } = require('../notificacoes/notif.service');

const router = express.Router();
const LIMITE = 5;

function limparStack(v) {
  if (!Array.isArray(v)) v = typeof v === 'string' ? v.split(',') : [];
  return v.map((s) => String(s).trim()).filter(Boolean).slice(0, 6).map((s) => s.slice(0, 24));
}
function faseValida(f) { return f === 'em construção' ? 'em construção' : 'no ar'; }
function trilhaValida(t) { return (t === 'tech' || t === 'cyber' || t === 'investig' || t === 'both') ? t : null; }

// criar projeto (limite verificado no servidor)
router.post('/projetos', requerLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const titulo = (b.titulo || '').trim();
    const descricao = (b.descricao || '').trim();
    if (!titulo) return res.status(400).json({ ok: false, erro: 'titulo_vazio' });
    if (titulo.length > 80) return res.status(400).json({ ok: false, erro: 'titulo_longo' });
    if (!descricao) return res.status(400).json({ ok: false, erro: 'descricao_vazia' });
    if (descricao.length > 500) return res.status(400).json({ ok: false, erro: 'descricao_longa' });

    const cnt = await pool.query('SELECT count(*)::int AS n FROM projetos WHERE dono_id = $1', [req.user.id]);
    if (cnt.rows[0].n >= LIMITE) return res.status(409).json({ ok: false, motivo: 'limite_atingido', limite: LIMITE });

    let trilha = trilhaValida(b.trilha);
    if (!trilha) {
      const d = await pool.query('SELECT trilha FROM contas WHERE id = $1', [req.user.id]);
      trilha = (d.rows[0] && d.rows[0].trilha) || null;
    }
    let repo = (b.repo_url || '').trim().slice(0, 300);
    if (repo && !/^https?:\/\//i.test(repo)) repo = 'https://' + repo.replace(/^\/+/, '');
    repo = repo || null;
    const stack = limparStack(b.stack);
    const fase = faseValida(b.fase);

    const { rows } = await pool.query(
      `INSERT INTO projetos (dono_id, titulo, descricao, repo_url, stack, fase, trilha)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.id, titulo, descricao, repo, stack, fase, trilha]
    );
    notificarTodos(pool, { ator_id: req.user.id, tipo: 'projeto_novo', ref_id: rows[0].id });
    // aviso automático no feed: "fulano publicou um novo projeto"
    try {
      await pool.query(
        `INSERT INTO posts (autor_id, corpo, tipo, ref_id) VALUES ($1, $2, 'projeto_novo', $3)`,
        [req.user.id, titulo.slice(0, 200), rows[0].id]
      );
    } catch (_e) { /* aviso é best-effort; não bloqueia a criação do projeto */ }
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

// listar todos os projetos (mais novos primeiro); marca o que é meu; respeita exposição
router.get('/projetos', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.titulo, p.descricao, p.repo_url, p.stack, p.fase, p.trilha,
              p.criado_em, p.editado_em, p.dono_id,
              c.handle, c.nome, c.exposicao, c.is_sud0,
              (SELECT count(*) FROM comentarios k WHERE k.projeto_id = p.id AND k.tipo = 'replica')    AS n_replicas,
              (SELECT count(*) FROM comentarios k WHERE k.projeto_id = p.id AND k.tipo = 'comentario') AS n_comentarios,
              rx.rocket, rx.brain, rx.bolt, rx.minha
         FROM projetos p JOIN contas c ON c.id = p.dono_id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE tipo='rocket')::int AS rocket,
                  count(*) FILTER (WHERE tipo='brain')::int  AS brain,
                  count(*) FILTER (WHERE tipo='bolt')::int   AS bolt,
                  max(tipo) FILTER (WHERE autor_id = $1)     AS minha
             FROM reacoes r WHERE r.alvo_tipo='projeto' AND r.alvo_id = p.id
         ) rx ON true
        ORDER BY p.criado_em DESC LIMIT 200`, [req.user.id]
    );
    const projetos = rows.map((r) => ({
      id: r.id, titulo: r.titulo, descricao: r.descricao,
      repo_url: r.repo_url, stack: r.stack || [], fase: r.fase, trilha: r.trilha,
      criado_em: r.criado_em, editado: !!r.editado_em,
      meu: r.dono_id === req.user.id,
      n_replicas: Number(r.n_replicas) || 0,
      n_comentarios: Number(r.n_comentarios) || 0,
      rx: { rocket: r.rocket || 0, brain: r.brain || 0, bolt: r.bolt || 0, minha: r.minha || null },
      autor: { handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null, is_sud0: r.is_sud0 },
    }));
    const meus = rows.filter((r) => r.dono_id === req.user.id).length;
    res.json({ ok: true, projetos, meus, limite: LIMITE });
  } catch (e) { next(e); }
});

// editar o próprio projeto
router.patch('/projetos/:id', requerLogin, async (req, res, next) => {
  try {
    const cur = await pool.query('SELECT dono_id FROM projetos WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ ok: false });
    if (cur.rows[0].dono_id !== req.user.id) return res.status(403).json({ ok: false, motivo: 'nao_e_seu' });

    const b = req.body || {};
    const titulo = (b.titulo || '').trim();
    const descricao = (b.descricao || '').trim();
    if (!titulo || titulo.length > 80) return res.status(400).json({ ok: false, erro: 'titulo' });
    if (!descricao || descricao.length > 500) return res.status(400).json({ ok: false, erro: 'descricao' });
    let repo = (b.repo_url || '').trim().slice(0, 300);
    if (repo && !/^https?:\/\//i.test(repo)) repo = 'https://' + repo.replace(/^\/+/, '');
    repo = repo || null;
    const stack = limparStack(b.stack);
    const fase = faseValida(b.fase);
    const trilha = trilhaValida(b.trilha);

    await pool.query(
      `UPDATE projetos SET titulo = $1, descricao = $2, repo_url = $3, stack = $4,
              fase = $5, trilha = COALESCE($6, trilha), editado_em = now()
        WHERE id = $7`,
      [titulo, descricao, repo, stack, fase, trilha, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// apagar: o dono apaga o seu; o sud0 apaga qualquer um (moderação)
router.delete('/projetos/:id', requerLogin, async (req, res, next) => {
  try {
    const sql = req.user.is_sud0
      ? 'DELETE FROM projetos WHERE id = $1 RETURNING id'
      : 'DELETE FROM projetos WHERE id = $1 AND dono_id = $2 RETURNING id';
    const params = req.user.is_sud0 ? [req.params.id] : [req.params.id, req.user.id];
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(403).json({ ok: false, motivo: 'nao_permitido' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function tipoComentario(t) { return t === 'comentario' ? 'comentario' : 'replica'; }

// listar réplicas + comentários de um projeto (mais antigos primeiro)
router.get('/projetos/:id/comentarios', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT k.id, k.tipo, k.corpo, k.criado_em, k.autor_id,
              c.handle, c.nome, c.exposicao, c.is_sud0, c.trilha,
              rx.rocket, rx.brain, rx.bolt, rx.minha
         FROM comentarios k JOIN contas c ON c.id = k.autor_id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE tipo='rocket')::int AS rocket,
                  count(*) FILTER (WHERE tipo='brain')::int  AS brain,
                  count(*) FILTER (WHERE tipo='bolt')::int   AS bolt,
                  max(tipo) FILTER (WHERE autor_id = $2)     AS minha
             FROM reacoes r WHERE r.alvo_tipo='comentario' AND r.alvo_id = k.id
         ) rx ON true
        WHERE k.projeto_id = $1 ORDER BY k.criado_em ASC LIMIT 500`,
      [req.params.id, req.user.id]
    );
    const comentarios = rows.map((r) => ({
      id: r.id, tipo: r.tipo, corpo: r.corpo, criado_em: r.criado_em,
      meu: r.autor_id === req.user.id,
      rx: { rocket: r.rocket || 0, brain: r.brain || 0, bolt: r.bolt || 0, minha: r.minha || null },
      autor: { handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null, is_sud0: r.is_sud0, trilha: r.trilha },
    }));
    res.json({ ok: true, comentarios });
  } catch (e) { next(e); }
});

// publicar uma réplica ou comentário num projeto
router.post('/projetos/:id/comentarios', requerLogin, async (req, res, next) => {
  try {
    const corpo = ((req.body && req.body.corpo) || '').trim();
    if (!corpo) return res.status(400).json({ ok: false, erro: 'vazio' });
    if (corpo.length > 800) return res.status(400).json({ ok: false, erro: 'muito_longo' });
    const tipo = tipoComentario(req.body && req.body.tipo);
    const ex = await pool.query('SELECT id FROM projetos WHERE id = $1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ ok: false });
    const { rows } = await pool.query(
      `INSERT INTO comentarios (projeto_id, autor_id, tipo, corpo) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.params.id, req.user.id, tipo, corpo]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

// apagar: o autor apaga o seu; o sud0 apaga qualquer um (moderação)
router.delete('/projetos/:id/comentarios/:cid', requerLogin, async (req, res, next) => {
  try {
    const sql = req.user.is_sud0
      ? 'DELETE FROM comentarios WHERE id = $1 AND projeto_id = $2 RETURNING id'
      : 'DELETE FROM comentarios WHERE id = $1 AND projeto_id = $2 AND autor_id = $3 RETURNING id';
    const params = req.user.is_sud0 ? [req.params.cid, req.params.id] : [req.params.cid, req.params.id, req.user.id];
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(403).json({ ok: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
