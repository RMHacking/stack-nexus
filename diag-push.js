// Diagnóstico do Web Push. Uso: node diag-push.js
require('dotenv').config();
const { pool } = require('./src/db');
(async () => {
  console.log('--- CHAVES / PACOTE (local) ---');
  console.log('VAPID_PUBLIC no .env :', process.env.VAPID_PUBLIC ? 'SIM' : 'NAO');
  console.log('VAPID_PRIVATE no .env:', process.env.VAPID_PRIVATE ? 'SIM' : 'NAO');
  try { require('web-push'); console.log('web-push instalado   : SIM'); } catch (e) { console.log('web-push instalado   : NAO'); }
  console.log('\n--- BANCO (Neon, vale pros 2 servidores) ---');
  try {
    const t = await pool.query("SELECT to_regclass('public.push_subscriptions') AS t");
    const existe = !!t.rows[0].t;
    console.log('tabela push_subscriptions:', existe ? 'EXISTE' : 'NAO EXISTE (falta rodar: npm run migrate)');
    if (existe) {
      const c = await pool.query('SELECT count(*)::int AS n, count(DISTINCT conta_id)::int AS contas FROM push_subscriptions');
      console.log('inscrições salvas        :', c.rows[0].n, '| contas distintas:', c.rows[0].contas);
      if (c.rows[0].n > 0) {
        const q = await pool.query(`SELECT ct.handle, left(ps.endpoint, 42) AS endpoint FROM push_subscriptions ps JOIN contas ct ON ct.id=ps.conta_id ORDER BY ps.criado_em DESC LIMIT 5`);
        q.rows.forEach(r => console.log('   @' + r.handle + '  ' + r.endpoint + '...'));
      }
    }
  } catch (e) { console.log('erro no banco:', e.message); }
  await pool.end();
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
