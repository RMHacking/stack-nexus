const express = require('express');
const { pool } = require('../db');
const { requerLogin, requerSud0 } = require('../auth/middleware');
const svc = require('../convites/convites.service');
const { notificar } = require('../notificacoes/notif.service');

const router = express.Router();
const TIPOS = ['velocidade', 'contribuicao', 'presenca', 'comunidade'];
const rotuloTipo = { velocidade: 'velocidade', contribuicao: 'contribuição', presenca: 'presença', comunidade: 'comunidade' };

// ---------------- sud0: lançar desafio ----------------
router.post('/admin/desafios', requerSud0, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const titulo = String(b.titulo || '').trim();
    if (!titulo) return res.status(400).json({ ok: false, erro: 'titulo' });
    if (titulo.length > 160) return res.status(400).json({ ok: false, erro: 'longo' });
    const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'comunidade';
    let premio = parseInt(b.premio, 10); if (!(premio >= 1)) premio = 1; if (premio > 50) premio = 50;

    await client.query('BEGIN');
    // card fixado no feed (fica no topo até encerrar)
    const corpo = '🏆 Novo desafio: ' + titulo + ' — prêmio: ' + premio + ' convite' + (premio > 1 ? 's' : '') + ' por vencedor · tipo ' + rotuloTipo[tipo] + '. Envie sua prova!';
    const post = await client.query(
      `INSERT INTO posts (autor_id, corpo, tipo, fixado) VALUES ($1,$2,'desafio',true) RETURNING id`,
      [req.user.id, corpo]);
    const d = await client.query(
      `INSERT INTO desafios (titulo, tipo, premio, criado_por, post_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [titulo, tipo, premio, req.user.id, post.rows[0].id]);
    await client.query(`UPDATE posts SET ref_id = $1 WHERE id = $2`, [d.rows[0].id, post.rows[0].id]);
    await client.query('COMMIT');
    res.json({ ok: true, id: d.rows[0].id, post_id: post.rows[0].id });
  } catch (e) { await client.query('ROLLBACK'); console.error('[desafio/criar]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code || '') + ' ' + String(e.message || '').slice(0, 120) }); }
  finally { client.release(); }
});

// ---------------- sud0: lista de desafios (com contagem de provas) ----------------
router.get('/admin/desafios', requerSud0, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.titulo, d.tipo, d.premio, d.ativo, d.criado_em,
              (SELECT count(*)::int FROM desafio_provas p WHERE p.desafio_id = d.id) AS provas,
              (SELECT count(*)::int FROM desafio_provas p WHERE p.desafio_id = d.id AND p.status='premiada') AS premiadas
         FROM desafios d ORDER BY d.ativo DESC, d.criado_em DESC LIMIT 100`);
    res.json({ ok: true, desafios: rows });
  } catch (e) { next(e); }
});

// ---------------- sud0: provas de um desafio ----------------
router.get('/admin/desafios/:id/provas', requerSud0, async (req, res, next) => {
  try {
    const d = await pool.query('SELECT id, titulo, premio, ativo FROM desafios WHERE id = $1', [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    const { rows } = await pool.query(
      `SELECT p.id, p.corpo, p.imagem, p.status, p.criado_em,
              c.handle, c.nome, c.exposicao, c.trilha, c.is_sud0
         FROM desafio_provas p JOIN contas c ON c.id = p.autor_id
        WHERE p.desafio_id = $1 ORDER BY p.criado_em ASC LIMIT 300`, [req.params.id]);
    res.json({ ok: true, desafio: d.rows[0], provas: rows.map((r) => ({
      id: r.id, corpo: r.corpo, imagem: r.imagem, status: r.status, criado_em: r.criado_em,
      handle: r.handle, nome: r.exposicao === 'aberto' ? r.nome : null, trilha: r.trilha, is_sud0: r.is_sud0,
    })) });
  } catch (e) { next(e); }
});

// ---------------- sud0: premiar uma prova (concede convites + notifica) ----------------
router.post('/admin/provas/:pid/premiar', requerSud0, async (req, res, next) => {
  try {
    const pv = await pool.query(
      `SELECT p.id, p.autor_id, p.status, d.id AS desafio_id, d.titulo, d.premio
         FROM desafio_provas p JOIN desafios d ON d.id = p.desafio_id WHERE p.id = $1`, [req.params.pid]);
    if (!pv.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    const p = pv.rows[0];
    if (p.status === 'premiada') return res.json({ ok: true, jah: true });
    let q = parseInt((req.body || {}).quantidade, 10); if (!(q >= 1)) q = p.premio; if (q > 50) q = 50;
    await svc.premiar(pool, { contaId: p.autor_id, quantidade: q, motivo: 'desafio: ' + p.titulo, desafioId: p.desafio_id, sud0Id: req.user.id });
    await pool.query(`UPDATE desafio_provas SET status='premiada' WHERE id=$1`, [p.id]);
    await notificar(pool, { destinatario_id: p.autor_id, ator_id: req.user.id, tipo: 'premiacao', dados: { quantidade: q } });
    // post de parabéns no feed (dá palco ao vencedor + motiva a rede)
    try {
      const w = await pool.query('SELECT handle FROM contas WHERE id = $1', [p.autor_id]);
      const wh = w.rows[0] && w.rows[0].handle;
      if (wh) {
        const corpo = '🏆 @' + wh + ' mandou bem no desafio "' + p.titulo + '" e levou ' + q + ' convite' + (q > 1 ? 's' : '') + '! É assim que a rede cresce — mostrando o que se faz, não o que se diz. Parabéns e bora pro próximo! 🚀';
        await pool.query(`INSERT INTO posts (autor_id, corpo, tipo) VALUES ($1,$2,'normal')`, [req.user.id, corpo]);
      }
    } catch (_e) { /* best-effort: o post é bônus, não trava a premiação */ }
    res.json({ ok: true });
  } catch (e) { console.error('[prova/premiar]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code || '') + ' ' + String(e.message || '').slice(0, 120) }); }
});

// ---------------- sud0: recusar uma prova ----------------
router.post('/admin/provas/:pid/recusar', requerSud0, async (req, res, next) => {
  try {
    const upd = await pool.query(`UPDATE desafio_provas SET status='recusada' WHERE id=$1 RETURNING id`, [req.params.pid]);
    if (!upd.rowCount) return res.status(404).json({ ok: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- sud0: encerrar desafio (desafixa o card) ----------------
router.post('/admin/desafios/:id/encerrar', requerSud0, async (req, res, next) => {
  try {
    const d = await pool.query('SELECT post_id FROM desafios WHERE id=$1', [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ ok: false });
    await pool.query(`UPDATE desafios SET ativo=false WHERE id=$1`, [req.params.id]);
    if (d.rows[0].post_id) await pool.query(`UPDATE posts SET fixado=false WHERE id=$1`, [d.rows[0].post_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------- membro: ver desafio + minha prova ----------------
router.get('/desafios/:id', requerLogin, async (req, res, next) => {
  try {
    const d = await pool.query('SELECT id, titulo, tipo, premio, ativo FROM desafios WHERE id=$1', [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    const mp = await pool.query('SELECT id, corpo, imagem, status, criado_em FROM desafio_provas WHERE desafio_id=$1 AND autor_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true, desafio: d.rows[0], minha_prova: mp.rows[0] || null });
  } catch (e) { next(e); }
});

// ---------------- membro: enviar prova ----------------
router.post('/desafios/:id/provas', requerLogin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const corpo = (b.corpo != null && String(b.corpo).trim()) ? String(b.corpo).trim().slice(0, 500) : null;
    const imagem = b.imagem ? String(b.imagem) : null;
    if (!corpo && !imagem) return res.status(400).json({ ok: false, erro: 'vazio' });
    if (imagem && imagem.length > 1500000) return res.status(413).json({ ok: false, erro: 'imagem_grande' });
    const d = await pool.query('SELECT id, ativo, criado_por FROM desafios WHERE id=$1', [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ ok: false, erro: 'nao_encontrado' });
    if (!d.rows[0].ativo) return res.status(400).json({ ok: false, erro: 'encerrado' });
    // uma prova por pessoa: upsert
    const ins = await pool.query(
      `INSERT INTO desafio_provas (desafio_id, autor_id, corpo, imagem) VALUES ($1,$2,$3,$4)
       ON CONFLICT (desafio_id, autor_id) DO UPDATE SET corpo=EXCLUDED.corpo, imagem=EXCLUDED.imagem, status='pendente', criado_em=now()
       RETURNING id`, [req.params.id, req.user.id, corpo, imagem]);
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { console.error('[prova/enviar]', e); res.status(500).json({ ok: false, erro: 'srv', detalhe: String(e.code || '') + ' ' + String(e.message || '').slice(0, 120) }); }
});

module.exports = router;
