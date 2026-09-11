// =====================================================================
// Eventos de convite — entrada em lote para um evento específico.
// Quem entra por aqui tem origem = o próprio evento (NÃO entra na
// árvore pessoal do sud0). "O cliente esconde, o servidor decide."
// =====================================================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const svc = require('../convites/convites.service');
const { requerSud0, requerLogin } = require('../auth/middleware');

const router = express.Router();
const gateLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// ---------------- sud0: criar / listar / ajustar ----------------
router.post('/admin/eventos', requerSud0, async (req, res, next) => {
  try {
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    const slots = parseInt(b.slots, 10);
    const bonus = parseInt(b.convite_bonus, 10);
    if (!nome) return res.status(400).json({ ok: false, erro: 'nome' });
    if (!(slots >= 0)) return res.status(400).json({ ok: false, erro: 'slots' });
    const { rows } = await pool.query(
      `INSERT INTO eventos (nome, codigo, slots_total, convite_bonus, chat_ativo, inicio, fim, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, nome, codigo, slots_total, slots_usados, convite_bonus, chat_ativo, inicio, fim, ativo, criado_em`,
      [nome, svc.gerarCodigo(), slots, bonus >= 0 ? bonus : 0, b.chat !== false, b.inicio || null, b.fim || null, req.user.id]
    );
    const ev = rows[0];
    // aviso no feed pra rede toda (opcional) — clicável pra qualquer membro compartilhar
    if (b.anunciar) {
      try {
        const corpo = ('🎟️ Evento aberto: ' + nome + ' — ' + slots + ' vaga' + (slots > 1 ? 's' : '') +
          '. Ajude a trazer gente boa pra rede.').slice(0, 500);
        await pool.query(
          `INSERT INTO posts (autor_id, corpo, tipo, ref_id, fixado) VALUES ($1,$2,'evento_novo',$3,true)`,
          [req.user.id, corpo, ev.id]);
      } catch (_e) { /* best-effort */ }
    }
    res.json({ ok: true, evento: ev });
  } catch (e) { next(e); }
});

router.get('/admin/eventos', requerSud0, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.nome, e.codigo, e.slots_total, e.slots_usados, e.convite_bonus,
              e.ativo, e.criado_em, e.chat_ativo, e.inicio, e.fim,
              (SELECT count(*)::int FROM contas c WHERE c.evento_id = e.id) AS entrantes
         FROM eventos e ORDER BY e.criado_em DESC`);
    res.json({ ok: true, eventos: rows });
  } catch (e) { next(e); }
});

// apagar um evento (sud0) — remove aviso do feed, o chat e desliga os entrantes
router.delete('/admin/eventos/:id', requerSud0, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ev = await client.query('SELECT id FROM eventos WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!ev.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false }); }
    await client.query("DELETE FROM posts WHERE tipo='evento_novo' AND ref_id=$1", [req.params.id]);
    await client.query('UPDATE contas SET evento_id=NULL WHERE evento_id=$1', [req.params.id]);
    await client.query('DELETE FROM eventos WHERE id=$1', [req.params.id]); // evento_mensagens cascata junto
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

// quem entrou por um evento — a "vida do evento"
router.get('/admin/eventos/:id/entradas', requerSud0, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT handle, membro_num, criado_em, exposicao, nome
         FROM contas WHERE evento_id = $1 ORDER BY criado_em DESC`, [req.params.id]);
    res.json({ ok: true, entradas: rows });
  } catch (e) { next(e); }
});

router.patch('/admin/eventos/:id', requerSud0, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    if (typeof b.ativo === 'boolean') { vals.push(b.ativo); sets.push('ativo = $' + vals.length); }
    if (b.slots_total != null && parseInt(b.slots_total, 10) >= 0) { vals.push(parseInt(b.slots_total, 10)); sets.push('slots_total = $' + vals.length); }
    if (b.convite_bonus != null && parseInt(b.convite_bonus, 10) >= 0) { vals.push(parseInt(b.convite_bonus, 10)); sets.push('convite_bonus = $' + vals.length); }
    if ('inicio' in b) { vals.push(b.inicio || null); sets.push('inicio = $' + vals.length); }
    if ('fim' in b) { vals.push(b.fim || null); sets.push('fim = $' + vals.length); }
    if (!sets.length) return res.status(400).json({ ok: false, erro: 'nada_pra_mudar' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE eventos SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, nome, codigo, slots_total, slots_usados, convite_bonus, ativo`, vals);
    if (!rows.length) return res.status(404).json({ ok: false });
    res.json({ ok: true, evento: rows[0] });
  } catch (e) {
    if (e.code === '23514') return res.status(400).json({ ok: false, erro: 'slots_menor_que_usados' });
    next(e);
  }
});

// ---------------- membro: info pra compartilhar um evento ----------------
router.get('/eventos/:id', requerLogin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT nome, codigo, slots_total, slots_usados, ativo, chat_ativo, inicio, fim,
              (inicio IS NOT NULL AND CURRENT_DATE < inicio) AS antes,
              (fim    IS NOT NULL AND CURRENT_DATE > fim)    AS encerrado
         FROM eventos WHERE id = $1`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false });
    const e = rows[0];
    let ultimas = [];
    if (e.chat_ativo) {
      const um = await pool.query(
        `SELECT c.handle, c.nome, c.exposicao, c.is_sud0, m.corpo
           FROM evento_mensagens m LEFT JOIN contas c ON c.id = m.autor_id
          WHERE m.evento_id = $1 AND m.removida = false
          ORDER BY m.criado_em DESC LIMIT 2`, [req.params.id]);
      ultimas = um.rows.reverse().map((r) => ({ handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null, is_sud0: r.is_sud0, corpo: r.corpo }));
    }
    res.json({ ok: true, nome: e.nome, codigo: e.codigo, slots_total: e.slots_total,
      slots_usados: e.slots_usados, ativo: e.ativo, disponivel: e.slots_total - e.slots_usados,
      tem_chat: e.chat_ativo, inicio: e.inicio, fim: e.fim, antes: e.antes, encerrado: e.encerrado, ultimas });
  } catch (e) { next(e); }
});

// ---------------- bate-papo do evento (dentro do post; aberto a qualquer membro) ----------------
router.get('/eventos/:id/chat', requerLogin, async (req, res, next) => {
  try {
    const ev = await pool.query('SELECT chat_ativo FROM eventos WHERE id=$1', [req.params.id]);
    if (!ev.rows.length) return res.status(404).json({ ok: false });
    const { rows } = await pool.query(
      `SELECT m.id, m.corpo, m.criado_em, m.removida, m.autor_id,
              c.handle, c.nome, c.exposicao, c.is_sud0
         FROM evento_mensagens m LEFT JOIN contas c ON c.id = m.autor_id
        WHERE m.evento_id=$1 ORDER BY m.criado_em ASC LIMIT 300`, [req.params.id]);
    res.json({ ok: true, chat_ativo: ev.rows[0].chat_ativo, sou_sud0: !!req.user.is_sud0,
      mensagens: rows.map((r) => ({ id: r.id, criado_em: r.criado_em, removida: r.removida,
        corpo: r.removida ? null : r.corpo, meu: r.autor_id === req.user.id,
        autor: r.removida ? null : { handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null, is_sud0: r.is_sud0 } })) });
  } catch (e) { next(e); }
});
router.post('/eventos/:id/chat', requerLogin, async (req, res, next) => {
  try {
    const corpo = ((req.body && req.body.corpo) || '').trim();
    if (!corpo) return res.status(400).json({ ok: false, erro: 'vazio' });
    if (corpo.length > 1000) return res.status(400).json({ ok: false, erro: 'muito_longo' });
    const ev = await pool.query('SELECT chat_ativo FROM eventos WHERE id=$1', [req.params.id]);
    if (!ev.rows.length) return res.status(404).json({ ok: false });
    if (!ev.rows[0].chat_ativo) return res.status(409).json({ ok: false, motivo: 'chat_desativado' });
    const { rows } = await pool.query(
      `INSERT INTO evento_mensagens (evento_id, autor_id, corpo) VALUES ($1,$2,$3) RETURNING id`,
      [req.params.id, req.user.id, corpo]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});
router.delete('/eventos/:id/chat/:mid', requerLogin, async (req, res, next) => {
  try {
    const sql = req.user.is_sud0
      ? 'UPDATE evento_mensagens SET removida=true WHERE id=$1 AND evento_id=$2 RETURNING id'
      : 'UPDATE evento_mensagens SET removida=true WHERE id=$1 AND evento_id=$2 AND autor_id=$3 RETURNING id';
    const params = req.user.is_sud0 ? [req.params.mid, req.params.id] : [req.params.mid, req.params.id, req.user.id];
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(403).json({ ok: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- público: gate do evento ----------------
router.get('/evento/:codigo', gateLimiter, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT nome, ativo, slots_total, slots_usados, inicio, fim,
              (inicio IS NOT NULL AND CURRENT_DATE < inicio) AS antes,
              (fim    IS NOT NULL AND CURRENT_DATE > fim)    AS depois
         FROM eventos WHERE codigo = $1`,
      [req.params.codigo]);
    if (!rows.length) return res.json({ ok: false, motivo: 'invalido' });
    const e = rows[0];
    if (!e.ativo) return res.json({ ok: false, motivo: 'fechado' });
    if (e.antes) return res.json({ ok: false, motivo: 'ainda_nao', inicio: e.inicio });
    if (e.depois) return res.json({ ok: false, motivo: 'encerrado' });
    if (e.slots_usados >= e.slots_total) return res.json({ ok: false, motivo: 'esgotado' });
    res.json({ ok: true, nome: e.nome, disponivel: e.slots_total - e.slots_usados });
  } catch (e) { next(e); }
});

// ---------------- público: concluir entrada pelo evento ----------------
router.post('/onboarding/evento', gateLimiter, async (req, res, next) => {
  const b = req.body || {};
  const codigo = String(b.codigo || '');
  const handle = String(b.handle || '').trim();
  if (!codigo || !handle || !b.email || !b.senha) return res.status(400).json({ ok: false, erro: 'dados_incompletos' });
  const senha_hash = await bcrypt.hash(String(b.senha), 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ev = await client.query(
      `SELECT id, nome, ativo, slots_total, slots_usados, convite_bonus,
              (inicio IS NOT NULL AND CURRENT_DATE < inicio) AS antes,
              (fim    IS NOT NULL AND CURRENT_DATE > fim)    AS depois
         FROM eventos WHERE codigo=$1 FOR UPDATE`, [codigo]);
    if (!ev.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, motivo: 'invalido' }); }
    const e = ev.rows[0];
    if (!e.ativo) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, motivo: 'fechado' }); }
    if (e.antes) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, motivo: 'ainda_nao' }); }
    if (e.depois) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, motivo: 'encerrado' }); }
    if (e.slots_usados >= e.slots_total) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, motivo: 'esgotado' }); }

    const nova = await client.query(
      `INSERT INTO contas
         (handle, email, senha_hash, provider, nome, trilha, exposicao,
          membro_num, origem_conta_id, linhagem, profundidade, evento_id)
       VALUES ($1,$2,$3,'email',$4,$5,COALESCE($6,'aberto')::exposicao_tipo,
               nextval('seq_membro_num'), NULL, '{}', 0, $7)
       RETURNING id, membro_num`,
      [handle, b.email, senha_hash, b.nome || null, b.trilha || null, b.exposicao || 'aberto', e.id]);
    const novaId = nova.rows[0].id;

    const link = await svc.criarLinkConvite(client, novaId, { slots: 3 + (e.convite_bonus || 0) }); // base 3 (regra 'entra com 3') + bonus do evento
    await client.query(`UPDATE eventos SET slots_usados = slots_usados + 1 WHERE id=$1`, [e.id]);
    await client.query('COMMIT');
    res.json({ ok: true, conta_id: novaId, membro_num: nova.rows[0].membro_num, convite_codigo: link.codigo, evento_nome: e.nome, convite_bonus: e.convite_bonus || 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const campo = /email/.test(err.detail || '') ? 'email' : 'handle';
      return res.status(409).json({ ok: false, motivo: campo === 'email' ? 'email_em_uso' : 'handle_em_uso' });
    }
    next(err);
  } finally { client.release(); }
});

module.exports = router;
