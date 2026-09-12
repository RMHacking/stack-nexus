const express = require('express');
const { pool } = require('../db');
const { requerLogin, requerSud0 } = require('../auth/middleware');
const { notificar } = require('../notificacoes/notif.service');

const router = express.Router();

// ---- membro: enviar denúncia (confidencial) ----
router.post('/denuncias', requerLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const motivo = (b.motivo != null ? String(b.motivo) : '').trim().slice(0, 800);
    if (!motivo) return res.status(400).json({ ok: false, erro: 'vazio' });
    let alvoHandle = b.alvo_handle ? String(b.alvo_handle).replace(/^@/, '').trim().slice(0, 40) : null;
    let alvoTipo = alvoHandle ? 'pessoa' : (['post', 'comentario', 'grupo'].includes(b.alvo_tipo) ? b.alvo_tipo : 'geral');
    const alvoId = b.alvo_id ? String(b.alvo_id) : null;
    const categoria = b.categoria ? String(b.categoria).slice(0, 60) : null;
    await pool.query(
      `INSERT INTO denuncias (denunciante_id, alvo_tipo, alvo_handle, alvo_id, categoria, motivo)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.id, alvoTipo, alvoHandle, alvoId, categoria, motivo]);
    res.json({ ok: true });
  } catch (e) { console.error('[denuncia]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code || '') + ' ' + String(e.message || '').slice(0, 120) }); }
});

// ---- sud0: caixa de denúncias ----
router.get('/admin/denuncias', requerSud0, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.alvo_tipo, d.alvo_handle, d.alvo_id, d.categoria, d.motivo, d.status, d.criado_em,
              c.handle AS denunciante
         FROM denuncias d LEFT JOIN contas c ON c.id = d.denunciante_id
        WHERE d.status = 'pendente'
        ORDER BY d.criado_em DESC LIMIT 100`);
    res.json({ ok: true, denuncias: rows });
  } catch (e) { next(e); }
});

// ---- sud0: julgar uma denúncia ----
// acao: expulsar | suspender | advertir | apagar | arquivar
router.post('/admin/denuncias/:id/resolver', requerSud0, async (req, res, next) => {
  try {
    const acao = String((req.body || {}).acao || '');
    const d = await pool.query('SELECT * FROM denuncias WHERE id = $1', [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ ok: false });
    const den = d.rows[0];

    // resolve a conta-alvo (por handle, ou autor do conteúdo)
    async function contaAlvo() {
      if (den.alvo_handle) {
        const q = await pool.query('SELECT id, handle, is_sud0 FROM contas WHERE lower(handle)=lower($1)', [den.alvo_handle]);
        return q.rows[0] || null;
      }
      if (den.alvo_id && den.alvo_tipo === 'post') {
        const q = await pool.query('SELECT c.id, c.handle, c.is_sud0 FROM posts p JOIN contas c ON c.id=p.autor_id WHERE p.id=$1', [den.alvo_id]);
        return q.rows[0] || null;
      }
      if (den.alvo_id && den.alvo_tipo === 'comentario') {
        const q = await pool.query('SELECT c.id, c.handle, c.is_sud0 FROM post_comentarios pc JOIN contas c ON c.id=pc.autor_id WHERE pc.id=$1', [den.alvo_id]);
        return q.rows[0] || null;
      }
      return null;
    }

    let detalhe = null;
    if (acao === 'expulsar' || acao === 'suspender' || acao === 'advertir') {
      const alvo = await contaAlvo();
      if (!alvo) return res.status(400).json({ ok: false, erro: 'sem_alvo' });
      if (alvo.is_sud0) return res.status(400).json({ ok: false, erro: 'sud0' });
      if (acao === 'expulsar') { await pool.query('UPDATE contas SET banido=true WHERE id=$1', [alvo.id]); detalhe = '@' + alvo.handle + ' expulso'; }
      else if (acao === 'suspender') { await pool.query("UPDATE contas SET suspenso_ate = now() + interval '7 days' WHERE id=$1", [alvo.id]); detalhe = '@' + alvo.handle + ' suspenso 7 dias'; }
      else if (acao === 'advertir') { await notificar(pool, { destinatario_id: alvo.id, ator_id: req.user.id, tipo: 'aviso', dados: { motivo: den.categoria || 'conduta' } }); detalhe = '@' + alvo.handle + ' advertido'; }
    } else if (acao === 'apagar') {
      if (!den.alvo_id) return res.status(400).json({ ok: false, erro: 'sem_conteudo' });
      if (den.alvo_tipo === 'post') await pool.query('DELETE FROM posts WHERE id=$1', [den.alvo_id]);
      else if (den.alvo_tipo === 'comentario') await pool.query('DELETE FROM post_comentarios WHERE id=$1', [den.alvo_id]);
      detalhe = 'conteúdo apagado';
    } else if (acao !== 'arquivar') {
      return res.status(400).json({ ok: false, erro: 'acao_invalida' });
    }

    const novoStatus = acao === 'arquivar' ? 'arquivada' : 'resolvida';
    await pool.query('UPDATE denuncias SET status=$1, acao=$2, resolvido_em=now() WHERE id=$3', [novoStatus, acao, den.id]);
    // limpa outras denúncias pendentes do mesmo alvo (uma decisão vale pra fila toda)
    if (den.alvo_handle && (acao === 'expulsar' || acao === 'suspender')) {
      await pool.query("UPDATE denuncias SET status='resolvida', acao=$1, resolvido_em=now() WHERE status='pendente' AND lower(alvo_handle)=lower($2) AND id<>$3", [acao, den.alvo_handle, den.id]);
    }
    res.json({ ok: true, detalhe });
  } catch (e) { console.error('[moderar]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code || '') + ' ' + String(e.message || '').slice(0, 120) }); }
});

// ---- sud0: ação direta sobre um membro (sem denúncia) ----
router.post('/admin/membro/acao', requerSud0, async (req, res, next) => {
  try {
    const b = req.body || {};
    const acao = String(b.acao || '');
    const handle = String(b.handle || '').replace(/^@/, '').trim();
    if (!handle) return res.status(400).json({ ok: false, erro: 'handle' });
    const q = await pool.query('SELECT id, handle, is_sud0 FROM contas WHERE lower(handle)=lower($1)', [handle]);
    if (!q.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    const alvo = q.rows[0];
    if (alvo.is_sud0) return res.status(400).json({ ok: false, erro: 'sud0' });
    if (acao === 'expulsar') await pool.query('UPDATE contas SET banido=true WHERE id=$1', [alvo.id]);
    else if (acao === 'suspender') await pool.query("UPDATE contas SET suspenso_ate = now() + interval '7 days' WHERE id=$1", [alvo.id]);
    else if (acao === 'advertir') await notificar(pool, { destinatario_id: alvo.id, ator_id: req.user.id, tipo: 'aviso', dados: { motivo: 'conduta' } });
    else return res.status(400).json({ ok: false, erro: 'acao' });
    res.json({ ok: true, handle: alvo.handle });
  } catch (e) { console.error('[membro/acao]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code || '') + ' ' + String(e.message || '').slice(0, 120) }); }
});

// ---- sud0: conceder/revogar Admin (moderador global) ----
router.post('/admin/admins', requerSud0, async (req, res, next) => {
  try {
    const b = req.body || {};
    const handle = String(b.handle || '').replace(/^@/, '').trim();
    const conceder = b.conceder !== false;
    if (!handle) return res.status(400).json({ ok: false, erro: 'handle' });
    const q = await pool.query('SELECT id, handle, nome, is_sud0 FROM contas WHERE lower(handle)=lower($1)', [handle]);
    if (!q.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    const alvo = q.rows[0];
    if (alvo.is_sud0) return res.status(400).json({ ok: false, erro: 'sud0' });
    await pool.query('UPDATE contas SET is_admin=$1 WHERE id=$2', [conceder, alvo.id]);
    if (conceder) {
      // conexão com o Fundador: o Admin passa a ver o rosto do sud0 e aparece ligado a ele
      try {
        await pool.query(`DELETE FROM conexoes WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1)`, [req.user.id, alvo.id]);
        await pool.query(`INSERT INTO conexoes (de_id, para_id, status) VALUES ($1,$2,'aceita')`, [req.user.id, alvo.id]);
      } catch (_e) {}
      await notificar(pool, { destinatario_id: alvo.id, ator_id: req.user.id, tipo: 'admin', dados: {} });
      if (b.anunciar !== false) {
        const corpo = '♛ @' + alvo.handle + ' agora é Admin — guardião do Stack_n3xus.\n\nEsse posto não se pede: é entregue a quem prova zelo pela rede. Aqui a régua é alta — e agora ele ajuda a mantê-la. Respeito. 🖤';
        try { await pool.query(`INSERT INTO posts (autor_id, corpo, fixado, tipo) VALUES ($1,$2,false,'comunicado')`, [req.user.id, corpo]); } catch (_e) {}
      }
    } else {
      // revogou: desfaz a conexão com o Fundador (o acesso ao perfil dele cai junto, via is_admin=false)
      try { await pool.query(`DELETE FROM conexoes WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1)`, [req.user.id, alvo.id]); } catch (_e) {}
    }
    res.json({ ok: true, handle: alvo.handle });
  } catch (e) { console.error('[admins]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code||'')+' '+String(e.message||'').slice(0,120) }); }
});
router.get('/admin/admins', requerSud0, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT handle, nome, exposicao, membro_num FROM contas WHERE is_admin=true ORDER BY membro_num NULLS LAST, handle`);
    res.json({ ok: true, admins: rows.map((r) => ({ handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null, membro_num: r.membro_num })) });
  } catch (e) { next(e); }
});

module.exports = router;
