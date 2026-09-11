// Diagnóstico das notificações. Rode: node diag-notif.js
const { pool } = require('./src/db');
(async () => {
  try {
    // 1) a tabela existe?
    const t = await pool.query(`SELECT to_regclass('public.notificacoes') AS tbl`);
    console.log('\n1) tabela notificacoes existe?  ->', t.rows[0].tbl ? 'SIM' : 'NÃO (rodar npm run migrate)');
    if (!t.rows[0].tbl) { await pool.end(); return; }

    // 2) quantas notificacoes e as ultimas 5
    const n = await pool.query(`SELECT count(*)::int AS c FROM notificacoes`);
    console.log('2) total de notificacoes no banco ->', n.rows[0].c);
    const u = await pool.query(
      `SELECT no.tipo, no.lida, to_char(no.criado_em,'DD/MM HH24:MI') AS quando,
              d.handle AS para, a.handle AS de, a.is_sud0 AS de_sud0
         FROM notificacoes no
         LEFT JOIN contas d ON d.id = no.destinatario_id
         LEFT JOIN contas a ON a.id = no.ator_id
        ORDER BY no.criado_em DESC LIMIT 5`);
    console.log('   ultimas 5:');
    if (!u.rows.length) console.log('   (nenhuma)');
    u.rows.forEach(r => console.log(`   - [${r.tipo}] para @${r.para} | de ${r.de_sud0?'sud0':('@'+(r.de||'?'))} | ${r.lida?'lida':'NAO lida'} | ${r.quando}`));

    // 3) contas reais
    const c = await pool.query(`SELECT handle, is_sud0 FROM contas ORDER BY is_sud0 DESC, criado_em`);
    console.log('\n3) contas:', c.rows.map(r => (r.is_sud0?'👑':'')+'@'+r.handle).join(', '));

    // 4) ultimos posts (id + dono) e ultimos comentarios (post + autor)
    const p = await pool.query(
      `SELECT p.id, co.handle AS dono, to_char(p.criado_em,'DD/MM HH24:MI') AS quando
         FROM posts p JOIN contas co ON co.id = p.autor_id
        ORDER BY p.criado_em DESC LIMIT 5`);
    console.log('\n4) ultimos posts (dono):');
    p.rows.forEach(r => console.log(`   - post ${String(r.id).slice(0,8)}.. dono @${r.dono} (${r.quando})`));
    const cm = await pool.query(
      `SELECT pc.post_id, ca.handle AS autor, ca.is_sud0 AS autor_sud0, to_char(pc.criado_em,'DD/MM HH24:MI') AS quando
         FROM post_comentarios pc JOIN contas ca ON ca.id = pc.autor_id
        ORDER BY pc.criado_em DESC LIMIT 5`);
    console.log('   ultimos comentarios (autor -> em qual post):');
    cm.rows.forEach(r => console.log(`   - ${r.autor_sud0?'sud0':('@'+r.autor)} comentou no post ${String(r.post_id).slice(0,8)}.. (${r.quando})`));

    console.log('\n--- fim ---\n');
  } catch (e) {
    console.error('ERRO:', e.message);
  } finally { await pool.end(); }
})();
