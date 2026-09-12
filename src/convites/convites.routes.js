const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const svc = require('./convites.service');
const { requerLogin, requerSud0 } = require('../auth/middleware');
const conexoesRoutes = require('../conexoes/conexoes.routes');
const { notificar } = require('../notificacoes/notif.service');

const router = express.Router();
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

// Reputação = ajuste do sud0 + reações recebidas (rocket3/brain2/bolt1) + contribuição (com teto) − decaimento por inatividade.
async function calcularReputacao(contaId) {
  const q = await pool.query(
    `SELECT
       (SELECT reputacao FROM contas WHERE id = $1) AS ajuste,
       COALESCE((
         SELECT SUM(CASE WHEN r.tipo='rocket' THEN 3 WHEN r.tipo='brain' THEN 2 WHEN r.tipo='bolt' THEN 1 ELSE 0 END)
           FROM reacoes r
          WHERE (r.alvo_tipo='post'       AND r.alvo_id IN (SELECT id FROM posts       WHERE autor_id=$1))
             OR (r.alvo_tipo='projeto'    AND r.alvo_id IN (SELECT id FROM projetos    WHERE dono_id=$1))
             OR (r.alvo_tipo='comentario' AND r.alvo_id IN (SELECT id FROM comentarios WHERE autor_id=$1))
             OR (r.alvo_tipo='comentario' AND r.alvo_id IN (SELECT id FROM post_comentarios WHERE autor_id=$1))
       ),0) AS pts_reacoes,
       (SELECT count(*) FROM posts       WHERE autor_id=$1) AS n_posts,
       (SELECT count(*) FROM projetos    WHERE dono_id=$1)  AS n_proj,
       (SELECT count(*) FROM comentarios WHERE autor_id=$1) AS n_com,
       (SELECT count(*) FROM post_comentarios WHERE autor_id=$1) AS n_postcom,
       GREATEST(
         COALESCE((SELECT max(criado_em) FROM posts       WHERE autor_id=$1), 'epoch'::timestamptz),
         COALESCE((SELECT max(criado_em) FROM projetos    WHERE dono_id=$1),  'epoch'::timestamptz),
         COALESCE((SELECT max(criado_em) FROM comentarios WHERE autor_id=$1), 'epoch'::timestamptz),
         COALESCE((SELECT max(criado_em) FROM post_comentarios WHERE autor_id=$1), 'epoch'::timestamptz),
         COALESCE((SELECT max(criado_em) FROM grupo_mensagens WHERE autor_id=$1), 'epoch'::timestamptz),
         (SELECT criado_em FROM contas WHERE id=$1)
       ) AS ultima`, [contaId]);
  const r = q.rows[0] || {};
  const ajuste = Number(r.ajuste) || 0;
  const pts = Number(r.pts_reacoes) || 0;
  const contrib = Math.min((Number(r.n_posts) || 0) + (Number(r.n_proj) || 0) * 3 + (Number(r.n_com) || 0) + (Number(r.n_postcom) || 0), 60);
  let decay = 0;
  if (r.ultima) { const dias = Math.floor((Date.now() - new Date(r.ultima).getTime()) / 86400000); if (dias > 14) decay = (dias - 14) * 2; }
  return Math.max(0, Math.round(ajuste + pts + contrib - decay));
}

// rate-limit no gate: evita brute force de códigos
const gateLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// ---------------- GATE / público ----------------
router.get('/convite/:codigo', gateLimiter, async (req, res, next) => {
  try {
    res.json(await svc.resolverGate(pool, req.params.codigo, req.user && req.user.id));
  } catch (e) { next(e); }
});

router.post('/convite/:codigo/reservar', gateLimiter, async (req, res, next) => {
  try {
    const r = await svc.reservarSlot(pool, req.params.codigo, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { next(e); }
});

// conclui o cadastro: cria a conta (com senha), consome o slot, grava a origem
router.post('/onboarding/concluir', async (req, res, next) => {
  try {
    const { resgateId, conta } = req.body || {};
    if (!resgateId || !conta || !conta.handle) return res.status(400).json({ erro: 'dados_incompletos' });
    const senha_hash = conta.senha ? await bcrypt.hash(conta.senha, 10) : null;
    const r = await svc.concluirResgate(pool, {
      resgateId,
      conta: { ...conta, senha_hash },
    });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) { next(e); }
});

// ---------------- Membro ----------------
router.get('/me/convite', requerLogin, async (req, res, next) => {
  try { res.json(await svc.meuConvite(pool, req.user.id)); } catch (e) { next(e); }
});
router.get('/me/arvore', requerLogin, async (req, res, next) => {
  try { res.json(await svc.minhaArvore(pool, req.user.id)); } catch (e) { next(e); }
});

// perfil real do usuário logado (dados + convite)
router.get('/me/perfil', requerLogin, async (req, res, next) => {
  try {
    const p = await pool.query(
      `SELECT c.id, c.handle, c.nome, c.bio, c.frase, c.foto_url, c.capa_url, c.trilha,
              c.exposicao, c.reputacao, c.membro_num, c.is_sud0, c.criado_em,
              o.handle AS origem_handle, o.nome AS origem_nome
         FROM contas c
         LEFT JOIN contas o ON o.id = c.origem_conta_id
        WHERE c.id = $1`,
      [req.user.id]
    );
    if (!p.rows.length) return res.status(404).json({ erro: 'nao_encontrado' });
    const convite = await svc.meuConvite(pool, req.user.id);
    // quantos eu já trouxe (descendência direta)
    const conv = await pool.query(
      `SELECT count(*)::int AS n FROM contas WHERE origem_conta_id = $1`, [req.user.id]
    );
    const rep = await calcularReputacao(req.user.id);
    const nConex = await conexoesRoutes.contarConexoes(req.user.id);
    res.json({ ...p.rows[0], reputacao: rep, convite, trouxe: conv.rows[0].n, conexoes: nConex });
  } catch (e) { next(e); }
});

// atualizar o proprio perfil (nome, frase, bio, exposicao, trilha, foto, capa)
router.patch('/me/perfil', requerLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    let i = 1;
    const MAXIMG = 700000; // ~700 KB de dataURL (imagem ja redimensionada no cliente)
    if (b.nome !== undefined)  { sets.push(`nome = $${i++}`);  vals.push(b.nome ? String(b.nome).slice(0, 120) : null); }
    if (b.frase !== undefined) { sets.push(`frase = $${i++}`); vals.push(b.frase ? String(b.frase).slice(0, 70) : null); }
    if (b.bio !== undefined)   { sets.push(`bio = $${i++}`);   vals.push(b.bio ? String(b.bio).slice(0, 160) : null); }
    if (b.exposicao !== undefined && ['aberto','reservado'].includes(b.exposicao)) { sets.push(`exposicao = $${i++}`); vals.push(b.exposicao); }
    if (b.trilha !== undefined) {
      if (b.trilha === null || b.trilha === '') { sets.push(`trilha = $${i++}`); vals.push(null); }
      else if (['tech','cyber','investig','both'].includes(b.trilha)) { sets.push(`trilha = $${i++}`); vals.push(b.trilha); }
    }
    for (const campo of ['foto_url','capa_url']) {
      if (b[campo] !== undefined) {
        const v = b[campo];
        if (v && String(v).length > MAXIMG) return res.status(413).json({ ok:false, erro:'imagem_grande' });
        sets.push(`${campo} = $${i++}`); vals.push(v || null);
      }
    }
    if (!sets.length) return res.status(400).json({ ok:false, erro:'nada_para_salvar' });
    vals.push(req.user.id);
    await pool.query(`UPDATE contas SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    res.json({ ok:true });
  } catch (e) { console.error('[perfil]', e); res.status(500).json({ ok:false, erro:'srv', detalhe:String(e.code||'')+' '+String(e.message||'').slice(0,120) }); }
});

// sugestoes de conexao: membros reais (mais novos primeiro), fora o sud0 e voce
router.get('/sugestoes', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT handle, nome, exposicao, trilha, membro_num, foto_url
         FROM contas
        WHERE is_sud0 = false AND id <> $1
        ORDER BY criado_em DESC
        LIMIT 8`, [req.user.id]
    );
    res.json({ ok:true, sugestoes: rows.map((r) => ({
      handle: r.handle,
      nome: r.exposicao === 'aberto' ? r.nome : null,
      trilha: r.trilha, membro_num: r.membro_num,
      foto_url: r.exposicao === 'aberto' ? r.foto_url : null,
    })) });
  } catch (e) { next(e); }
});

// busca de membros (autocomplete dos campos @handle do Config) — só sud0
router.get('/admin/membros', requerSud0, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').replace(/^@/, '').trim();
    if (q.length < 1) return res.json({ ok: true, membros: [] });
    const termo = q.replace(/[%_\\]/g, '\\$&');
    const { rows } = await pool.query(
      `SELECT handle, nome, membro_num
         FROM contas
        WHERE is_sud0 = false
          AND (handle ILIKE $1 || '%' ESCAPE '\\'
               OR handle ILIKE '%' || $1 || '%' ESCAPE '\\'
               OR nome ILIKE '%' || $1 || '%' ESCAPE '\\')
        ORDER BY (handle ILIKE $1 || '%' ESCAPE '\\') DESC, handle
        LIMIT 8`, [termo]);
    res.json({ ok: true, membros: rows });
  } catch (e) { next(e); }
});

// ---------------- sud0 ----------------
// perfil público de um membro (rede fechada: precisa estar logado)
router.get('/perfil/:handle', requerLogin, async (req, res, next) => {
  try {
    const p = await pool.query(
      `SELECT c.id, c.handle, c.nome, c.bio, c.frase, c.foto_url, c.capa_url, c.trilha,
              c.exposicao, c.reputacao, c.membro_num, c.is_sud0, c.criado_em,
              o.handle AS origem_handle
         FROM contas c LEFT JOIN contas o ON o.id = c.origem_conta_id
        WHERE lower(c.handle) = lower($1)`,
      [req.params.handle]
    );
    if (!p.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    const r = p.rows[0];
    if (r.is_sud0) return res.json({ ok: true, is_sud0: true, handle: r.handle }); // fundador anônimo -> 403 no cliente
    const reservado = r.exposicao !== 'aberto';
    const proj = await pool.query('SELECT count(*)::int AS n FROM projetos WHERE dono_id = $1', [r.id]);
    const trouxe = await pool.query('SELECT count(*)::int AS n FROM contas WHERE origem_conta_id = $1', [r.id]);
    res.json({
      ok: true, handle: r.handle,
      nome: reservado ? null : r.nome,
      foto_url: reservado ? null : r.foto_url,
      bio: r.bio, frase: r.frase, trilha: r.trilha, capa_url: reservado ? null : r.capa_url,
      exposicao: r.exposicao, reputacao: await calcularReputacao(r.id), membro_num: r.membro_num,
      origem_handle: r.origem_handle,
      projetos: proj.rows[0].n, trouxe: trouxe.rows[0].n,
      conexoes: await conexoesRoutes.contarConexoes(r.id),
      estado: await conexoesRoutes.estadoEntre(req.user.id, r.id),
    });
  } catch (e) { next(e); }
});

router.post('/admin/premiar', requerSud0, async (req, res, next) => {
  try {
    const b = req.body || {};
    const quantidade = parseInt(b.quantidade, 10);
    if (!(quantidade > 0)) return res.status(400).json({ ok: false, erro: 'quantidade' });
    let cid = b.contaId, handle = null;
    if (!cid && b.handle) {
      const r = await pool.query('SELECT id, handle FROM contas WHERE lower(handle) = lower($1) AND is_sud0 = false', [String(b.handle).replace(/^@/, '')]);
      if (!r.rows.length) return res.status(404).json({ ok: false, motivo: 'nao_encontrado' });
      cid = r.rows[0].id; handle = r.rows[0].handle;
    } else if (cid) {
      const r = await pool.query('SELECT handle FROM contas WHERE id = $1', [cid]);
      handle = r.rows[0] && r.rows[0].handle;
    }
    if (!cid) return res.status(400).json({ ok: false, erro: 'alvo' });
    await svc.premiar(pool, { contaId: cid, quantidade, motivo: b.motivo, desafioId: b.desafioId, sud0Id: req.user.id });
    await notificar(pool, { destinatario_id: cid, ator_id: req.user.id, tipo: 'premiacao', dados: { quantidade } });
    // anúncio público no feed (dá palco a quem ganhou)
    if (b.anunciar && handle) {
      try {
        await pool.query(`INSERT INTO posts (autor_id, corpo) VALUES ($1, $2)`,
          [req.user.id, ('🎖️ @' + handle + ' foi premiado com ' + quantidade + ' convite' + (quantidade > 1 ? 's' : '') + (b.motivo ? (' — ' + String(b.motivo).slice(0, 300)) : '')).slice(0, 500)]);
      } catch (_e) { /* best-effort */ }
    }
    res.json({ ok: true, handle });
  } catch (e) { next(e); }
});

// economia de convites (números reais pro painel)
router.get('/admin/economia', requerSud0, async (_req, res, next) => {
  try {
    const e = await pool.query('SELECT COALESCE(SUM(slots_disponiveis),0)::int AS circulando, COALESCE(SUM(slots_usados),0)::int AS usados FROM convite_saldo');
    const a = await pool.query("SELECT count(*) FILTER (WHERE status='concluido')::int AS ok, count(*) FILTER (WHERE status IN ('concluido','expirado','cancelado'))::int AS total FROM resgates");
    const ok = a.rows[0].ok, total = a.rows[0].total;
    res.json({ ok: true, circulando: e.rows[0].circulando, usados: e.rows[0].usados, aceite: total ? Math.round(ok / total * 100) : 0 });
  } catch (e) { next(e); }
});

// visão geral do painel do sud0 (números reais + últimas premiações)
router.get('/admin/visaogeral', requerSud0, async (_req, res, next) => {
  try {
    const m = await pool.query('SELECT count(*)::int AS n FROM contas');
    const e = await pool.query('SELECT COALESCE(SUM(slots_disponiveis),0)::int AS c FROM convite_saldo');
    const g = await pool.query("SELECT count(*)::int AS n FROM convite_links WHERE tipo='genesis'");
    const pr = await pool.query(
      `SELECT p.quantidade, p.motivo, p.criado_em, c.handle
         FROM premiacoes p JOIN contas c ON c.id = p.conta_id
        ORDER BY p.criado_em DESC LIMIT 8`);
    res.json({ ok: true, membros: m.rows[0].n, circulando: e.rows[0].c, genesis: g.rows[0].n,
      premiacoes: pr.rows.map((r) => ({ handle: r.handle, quantidade: r.quantidade, motivo: r.motivo, criado_em: r.criado_em })) });
  } catch (e) { next(e); }
});

// ajustar o saldo de convites de alguém (sud0) — +/− no total, sem descer abaixo do já usado
router.post('/admin/convites/ajustar', requerSud0, async (req, res, next) => {
  try {
    const b = req.body || {};
    const handle = String(b.handle || '').replace(/^@/, '').trim();
    const delta = parseInt(b.delta, 10);
    if (!handle || !Number.isFinite(delta)) return res.status(400).json({ ok: false, erro: 'dados' });
    const q = await pool.query('SELECT id, is_sud0 FROM contas WHERE lower(handle)=lower($1)', [handle]);
    if (!q.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    if (q.rows[0].is_sud0) return res.status(400).json({ ok: false, erro: 'sud0' });
    const upd = await pool.query('UPDATE convite_links SET slots_total = GREATEST(slots_usados, slots_total + $1) WHERE conta_id=$2 RETURNING id', [delta, q.rows[0].id]);
    if (!upd.rowCount) return res.status(404).json({ ok: false, erro: 'sem_convite' });
    let saldo = null; try { const c = await svc.meuConvite(pool, q.rows[0].id); if (c && c.slots_disponiveis != null) saldo = c.slots_disponiveis; } catch (_e) {}
    res.json({ ok: true, saldo });
  } catch (e) { console.error('[ajustar-saldo]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code||'')+' '+String(e.message||'').slice(0,120) }); }
});

// ajuste manual de reputação pelo sud0 (o "dedo na régua")
router.post('/admin/reputacao', requerSud0, async (req, res, next) => {
  try {
    const { handle, delta } = req.body || {};
    const d = parseInt(delta, 10);
    if (!handle || !Number.isFinite(d)) return res.status(400).json({ ok: false, erro: 'dados' });
    const r = await pool.query('UPDATE contas SET reputacao = reputacao + $1 WHERE lower(handle) = lower($2) RETURNING id', [d, handle]);
    if (!r.rows.length) return res.status(404).json({ ok: false });
    res.json({ ok: true, reputacao: await calcularReputacao(r.rows[0].id) });
  } catch (e) { next(e); }
});
router.get('/admin/entradas', requerSud0, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.handle AS convidado, c.membro_num, c.linhagem, r.concluido_em,
              dono.handle AS convidado_por
         FROM resgates r
         JOIN contas c ON c.id = r.convidado_conta_id
         JOIN convite_links l ON l.id = r.convite_link_id
         JOIN contas dono ON dono.id = l.conta_id
        WHERE r.status = 'concluido'
        ORDER BY r.concluido_em DESC LIMIT 50`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
