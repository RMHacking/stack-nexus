// Cria um MEMBRO de teste (não-sud0), trazido pelo sud0 — só pra testar DM/feed/grupos.
// Uso (na pasta backend):
//   node scripts/criar-membro-teste.js <handle> <email> <senha> [tech|cyber|both]
// Ex.: node scripts/criar-membro-teste.js joao joao@teste.com senha123 tech
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

const handle = process.argv[2], email = process.argv[3], senha = process.argv[4];
const trilha = (process.argv[5] || 'tech');
if (!handle || !email || !senha) {
  console.error('Uso: node scripts/criar-membro-teste.js <handle> <email> <senha> [tech|cyber|both]');
  process.exit(1);
}
if (!['tech', 'cyber', 'both'].includes(trilha)) { console.error("trilha deve ser tech, cyber ou both"); process.exit(1); }

(async () => {
  const sud0 = await pool.query("SELECT id FROM contas WHERE is_sud0 = true LIMIT 1");
  const origem = sud0.rows[0] ? sud0.rows[0].id : null;
  const hash = await bcrypt.hash(senha, 10);
  const num = await pool.query("SELECT nextval('seq_membro_num')::int AS n");
  const r = await pool.query(
    `INSERT INTO contas (handle, email, senha_hash, provider, nome, trilha, exposicao, membro_num, origem_conta_id)
     VALUES ($1,$2,$3,'email',$4,$5,'aberto',$6,$7)
     RETURNING id, handle, email, membro_num`,
    [handle, email, hash, handle, trilha, num.rows[0].n, origem]);
  console.log('✓ membro de teste criado:');
  console.log('  @' + r.rows[0].handle + '  ·  login: ' + r.rows[0].email + '  ·  membro #' + r.rows[0].membro_num + '  ·  trilha ' + trilha);
  console.log('  senha: a que você digitou');
  await pool.end();
})().catch((e) => {
  if (e.code === '23505') console.error('Erro: handle ou email já está em uso.');
  else console.error('Erro:', e.message);
  process.exit(1);
});
