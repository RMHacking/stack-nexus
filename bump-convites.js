// Ajusta o SALDO TOTAL de convites de uma conta (serve pro sud0, que o painel não deixa).
// Uso (na pasta backend):  node bump-convites.js <handle> <total>
// Ex.:  node bump-convites.js sud0 3000
const { pool } = require('./src/db');
const handle = (process.argv[2] || 'sud0').replace(/^@/, '');
const total = parseInt(process.argv[3] || '3000', 10);
if (!Number.isFinite(total) || total < 0) { console.error('total inválido'); process.exit(1); }
(async () => {
  const c = await pool.query('SELECT id, handle, is_sud0 FROM contas WHERE lower(handle)=lower($1)', [handle]);
  if (!c.rows.length) { console.error('conta @' + handle + ' não encontrada'); process.exit(1); }
  const conta = c.rows[0];
  const upd = await pool.query(
    'UPDATE convite_links SET slots_total = GREATEST(slots_usados, $1) WHERE conta_id=$2 RETURNING slots_total, slots_usados', [total, conta.id]);
  if (!upd.rowCount) { console.error('@' + conta.handle + ' não tem convite_link'); process.exit(1); }
  const r = upd.rows[0];
  console.log('✓ @' + conta.handle + (conta.is_sud0 ? ' (Fundador)' : '') + ' — slots_total = ' + r.slots_total + ' (usados ' + r.slots_usados + ' → disponível ' + (r.slots_total - r.slots_usados) + ')');
  await pool.end();
})().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
