// Readmite (des-expulsa) uma conta: tira o banido, ela volta a logar com o mesmo email/senha.
// Uso (na pasta backend):  node readmitir.js <handle>
const { pool } = require('./src/db');
const handle = (process.argv[2] || '').replace(/^@/, '');
if (!handle) { console.error('Uso: node readmitir.js <handle>'); process.exit(1); }
(async () => {
  const r = await pool.query(
    "UPDATE contas SET banido=false, suspenso_ate=NULL, pendente_aprovacao=false WHERE lower(handle)=lower($1) AND is_sud0=false RETURNING handle, membro_num",
    [handle]);
  if (!r.rowCount) console.error('nao achei @' + handle + ' (ou e o sud0)');
  else console.log('✓ @' + r.rows[0].handle + ' readmitido — pode logar de novo com o mesmo email e senha. Some da arvore a marca de expulso.');
  await pool.end();
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
