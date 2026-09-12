// Mostra a verdade do banco pra depurar a árvore/expulsão.
// Uso: node diag-arvore.js
const { pool } = require('./src/db');
(async () => {
  const { rows } = await pool.query(
    `SELECT c.membro_num, c.handle, c.is_sud0, c.banido, c.pendente_aprovacao,
            o.handle AS origem_handle, o.is_sud0 AS origem_eh_sud0
       FROM contas c LEFT JOIN contas o ON o.id = c.origem_conta_id
      ORDER BY c.is_sud0 DESC, c.membro_num NULLS LAST, c.criado_em`);
  console.log('\n=== CONTAS ===');
  for (const r of rows) {
    const flags = [
      r.is_sud0 ? 'SUD0' : '#' + (r.membro_num ?? '-'),
      r.banido ? 'BANIDO' : '',
      r.pendente_aprovacao ? 'PENDENTE' : '',
    ].filter(Boolean).join(' ');
    const origem = r.origem_handle ? ('@' + r.origem_handle + (r.origem_eh_sud0 ? ' (sud0)' : '')) : (r.is_sud0 ? '—' : 'SEM ORIGEM (raiz/evento?)');
    console.log('@' + (r.handle || '').padEnd(16) + ' ' + flags.padEnd(24) + ' origem: ' + origem);
  }
  console.log('');
  await pool.end();
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
