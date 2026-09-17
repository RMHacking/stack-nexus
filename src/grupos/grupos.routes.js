// StackGroups — grupos, membros e chat do grupo.
// admin (do grupo) apaga msg e expulsa; sud0 tem poder total (inclusive apagar o grupo).
const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');
const { notificarTodos, pushPara } = require('../notificacoes/notif.service');

const router = express.Router();
const LIMITE = 3;

function trilhaValida(t) { return (t === 'tech' || t === 'cyber' || t === 'investig' || t === 'both') ? t : null; }
async function papelDe(grupoId, contaId) {
  const r = await pool.query('SELECT papel FROM grupo_membros WHERE grupo_id = $1 AND conta_id = $2', [grupoId, contaId]);
  return r.rows.length ? r.rows[0].papel : null;
}
function podeModerar(papel, isSud0) { return !!isSud0 || papel === 'admin'; }
async function ehAdminGlobal(contaId) { const r = await pool.query('SELECT is_admin FROM contas WHERE id=$1', [contaId]); return !!(r.rows[0] && r.rows[0].is_admin); }

// listar grupos (marca se sou membro e meu papel; conta quantos sou membro p/ o limite)
router.get('/grupos', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.nome, g.descricao, g.trilha, g.criado_em, c.handle AS criador_handle,
              (SELECT count(*)::int FROM grupo_membros m WHERE m.grupo_id = g.id) AS membros,
              (SELECT papel FROM grupo_membros m WHERE m.grupo_id = g.id AND m.conta_id = $1) AS meu_papel
         FROM grupos g JOIN contas c ON c.id = g.criador_id
        ORDER BY g.criado_em DESC LIMIT 200`, [req.user.id]);
    const grupos = rows.map((r) => ({
      id: r.id, nome: r.nome, descricao: r.descricao, trilha: r.trilha,
      criador_handle: r.criador_handle, membros: r.membros,
      sou_membro: !!r.meu_papel, meu_papel: r.meu_papel,
    }));
    const meus = grupos.filter((g) => g.sou_membro).length;
    res.json({ ok: true, grupos, meus, limite: LIMITE });
  } catch (e) { next(e); }
});

// criar grupo (limite 3; criador vira admin)
router.post('/grupos', requerLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const nome = (b.nome || '').trim();
    if (!nome) return res.status(400).json({ ok: false, erro: 'nome_vazio' });
    if (nome.length > 60) return res.status(400).json({ ok: false, erro: 'nome_longo' });
    const descricao = (b.descricao || '').trim().slice(0, 200) || null;
    const trilha = trilhaValida(b.trilha);
    const cnt = await pool.query('SELECT count(*)::int AS n FROM grupo_membros WHERE conta_id = $1', [req.user.id]);
    if (cnt.rows[0].n >= LIMITE) return res.status(409).json({ ok: false, motivo: 'limite_atingido', limite: LIMITE });
    const g = await pool.query(
      `INSERT INTO grupos (nome, descricao, trilha, criador_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [nome, descricao, trilha, req.user.id]);
    await pool.query(`INSERT INTO grupo_membros (grupo_id, conta_id, papel) VALUES ($1,$2,'admin')`, [g.rows[0].id, req.user.id]);
    // aviso automático no feed: "fulano criou um novo grupo"
    try {
      await pool.query(
        `INSERT INTO posts (autor_id, corpo, tipo, ref_id) VALUES ($1, $2, 'grupo_novo', $3)`,
        [req.user.id, nome.slice(0, 200), g.rows[0].id]
      );
    } catch (_e) { /* best-effort */ }
    notificarTodos(pool, { ator_id: req.user.id, tipo: 'grupo_novo', ref_id: g.rows[0].id });
    res.json({ ok: true, id: g.rows[0].id });
  } catch (e) { next(e); }
});

// entrar num grupo (limite 3)
router.post('/grupos/:id/entrar', requerLogin, async (req, res, next) => {
  try {
    const ex = await pool.query('SELECT id FROM grupos WHERE id = $1', [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ ok: false });
    if (await papelDe(req.params.id, req.user.id)) return res.json({ ok: true, ja: true });
    const cnt = await pool.query('SELECT count(*)::int AS n FROM grupo_membros WHERE conta_id = $1', [req.user.id]);
    if (cnt.rows[0].n >= LIMITE) return res.status(409).json({ ok: false, motivo: 'limite_atingido', limite: LIMITE });
    await pool.query(`INSERT INTO grupo_membros (grupo_id, conta_id, papel) VALUES ($1,$2,'membro') ON CONFLICT DO NOTHING`, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// sair do grupo
router.post('/grupos/:id/sair', requerLogin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM grupo_membros WHERE grupo_id = $1 AND conta_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// mensagens + cabeçalho do grupo (precisa ser membro; sud0 vê qualquer um)
router.get('/grupos/:id/mensagens', requerLogin, async (req, res, next) => {
  try {
    const g = await pool.query(
      `SELECT g.id, g.nome, g.descricao, g.trilha, g.criador_id, c.handle AS criador_handle,
              (SELECT count(*)::int FROM grupo_membros m WHERE m.grupo_id = g.id) AS membros
         FROM grupos g JOIN contas c ON c.id = g.criador_id WHERE g.id = $1`, [req.params.id]);
    if (!g.rows.length) return res.status(404).json({ ok: false });
    const papel = await papelDe(req.params.id, req.user.id);
    if (!papel && !req.user.is_sud0) return res.status(403).json({ ok: false, motivo: 'nao_e_membro' });
    const { rows } = await pool.query(
      `SELECT msg.id, msg.corpo, msg.criado_em, msg.removida, msg.removida_motivo, msg.autor_id,
              c.handle, c.nome, c.exposicao, c.trilha, c.is_sud0,
              gm.papel AS autor_papel, rp.handle AS removida_por_handle
         FROM grupo_mensagens msg
         LEFT JOIN contas c ON c.id = msg.autor_id
         LEFT JOIN grupo_membros gm ON gm.grupo_id = msg.grupo_id AND gm.conta_id = msg.autor_id
         LEFT JOIN contas rp ON rp.id = msg.removida_por
        WHERE msg.grupo_id = $1 ORDER BY msg.criado_em ASC LIMIT 300`, [req.params.id]);
    const mensagens = rows.map((r) => ({
      id: r.id, criado_em: r.criado_em, removida: r.removida,
      corpo: r.removida ? null : r.corpo,
      removida_motivo: r.removida_motivo, removida_por: r.removida_por_handle,
      meu: r.autor_id === req.user.id,
      autor: r.removida ? null : {
        id: r.autor_id, handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null,
        trilha: r.trilha, is_sud0: r.is_sud0, papel: r.autor_papel,
      },
    }));
    res.json({
      ok: true,
      grupo: {
        id: g.rows[0].id, nome: g.rows[0].nome, descricao: g.rows[0].descricao,
        trilha: g.rows[0].trilha, criador_handle: g.rows[0].criador_handle, membros: g.rows[0].membros,
      },
      meu_papel: papel, sou_admin: podeModerar(papel, req.user.is_sud0), sou_sud0: !!req.user.is_sud0,
      mensagens,
    });
  } catch (e) { next(e); }
});

// enviar mensagem (precisa ser membro)
router.post('/grupos/:id/mensagens', requerLogin, async (req, res, next) => {
  try {
    const corpo = ((req.body && req.body.corpo) || '').trim();
    if (!corpo) return res.status(400).json({ ok: false, erro: 'vazio' });
    if (corpo.length > 1000) return res.status(400).json({ ok: false, erro: 'muito_longo' });
    if (!(await papelDe(req.params.id, req.user.id))) return res.status(403).json({ ok: false, motivo: 'nao_e_membro' });
    const { rows } = await pool.query(
      `INSERT INTO grupo_mensagens (grupo_id, autor_id, corpo) VALUES ($1,$2,$3) RETURNING id`,
      [req.params.id, req.user.id, corpo]);
    // push pros membros do grupo (menos quem enviou)
    (async () => {
      try {
        const ms = await pool.query('SELECT conta_id FROM grupo_membros WHERE grupo_id=$1 AND conta_id<>$2', [req.params.id, req.user.id]);
        const gr = await pool.query('SELECT nome FROM grupos WHERE id=$1', [req.params.id]);
        const me = await pool.query('SELECT nome, handle, exposicao FROM contas WHERE id=$1', [req.user.id]);
        let nome = 'Alguém'; if (me.rows[0]) nome = (me.rows[0].exposicao === 'aberto' && me.rows[0].nome) ? me.rows[0].nome : ('@' + me.rows[0].handle);
        const gnome = (gr.rows[0] && gr.rows[0].nome) || 'grupo';
        pushPara(pool, ms.rows.map(m => m.conta_id), { title: gnome, body: nome + ': ' + corpo.slice(0, 120), url: '/stack-nexus-app-final.html' });
      } catch (_e) {}
    })();
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

// remover (soft) uma mensagem: admin do grupo ou sud0
router.post('/grupos/:id/mensagens/:mid/remover', requerLogin, async (req, res, next) => {
  try {
    const papel = await papelDe(req.params.id, req.user.id);
    if (!podeModerar(papel, req.user.is_sud0) && !(await ehAdminGlobal(req.user.id))) return res.status(403).json({ ok: false });
    const motivo = ((req.body && req.body.motivo) || '').trim().slice(0, 80) || 'moderação';
    const { rows } = await pool.query(
      `UPDATE grupo_mensagens SET removida = true, removida_por = $1, removida_motivo = $2
        WHERE id = $3 AND grupo_id = $4 AND removida = false RETURNING id`,
      [req.user.id, motivo, req.params.mid, req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// expulsar um membro: admin ou sud0 (criador só o sud0 expulsa)
router.post('/grupos/:id/expulsar', requerLogin, async (req, res, next) => {
  try {
    const papel = await papelDe(req.params.id, req.user.id);
    if (!podeModerar(papel, req.user.is_sud0) && !(await ehAdminGlobal(req.user.id))) return res.status(403).json({ ok: false });
    const alvo = req.body && req.body.conta_id;
    if (!alvo) return res.status(400).json({ ok: false });
    const cr = await pool.query('SELECT criador_id FROM grupos WHERE id = $1', [req.params.id]);
    if (cr.rows.length && cr.rows[0].criador_id === alvo && !req.user.is_sud0)
      return res.status(403).json({ ok: false, motivo: 'nao_pode_criador' });
    await pool.query('DELETE FROM grupo_membros WHERE grupo_id = $1 AND conta_id = $2', [req.params.id, alvo]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// apagar o grupo inteiro: só sud0
router.delete('/grupos/:id', requerLogin, async (req, res, next) => {
  try {
    if (!req.user.is_sud0) return res.status(403).json({ ok: false, motivo: 'so_sud0' });
    const { rows } = await pool.query('DELETE FROM grupos WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
