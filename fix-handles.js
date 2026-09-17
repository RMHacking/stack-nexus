// Normaliza @handles salvos errado (com @ na frente ou caracteres inválidos).
// Uso: node fix-handles.js            -> lista o que corrigiria
//      node fix-handles.js aplicar    -> corrige de verdade
require('dotenv').config();
const { pool } = require('./src/db');
(async () => {
  const bad = await pool.query("SELECT id, handle FROM contas WHERE handle LIKE '@%' OR handle ~ '[^A-Za-z0-9_]'");
  if (!bad.rows.length) { console.log('Nenhum handle problemático. 🎉'); await pool.end(); return; }
  const aplicar = process.argv[2] === 'aplicar';
  for (const r of bad.rows) {
    const novo = String(r.handle).replace(/^@+/, '').replace(/[^A-Za-z0-9_]/g, '');
    if (!novo) { console.log('PULEI (ficaria vazio): "' + r.handle + '"'); continue; }
    if (!aplicar) { console.log('"' + r.handle + '"  ->  "' + novo + '"'); continue; }
    try { await pool.query('UPDATE contas SET handle=$1 WHERE id=$2', [novo, r.id]); console.log('✓ "' + r.handle + '"  ->  "' + novo + '"'); }
    catch (e) { console.log('✗ erro em "' + r.handle + '": ' + e.message + (e.code === '23505' ? ' (já existe alguém com esse @handle)' : '')); }
  }
  console.log('\n' + (aplicar ? 'Feito.' : 'Se estiver certo, rode: node fix-handles.js aplicar'));
  await pool.end();
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
