// Troca o EMAIL (login) e a SENHA da conta fundadora (sud0).
// O @handle continua "sud0" (identidade anônima do fundador).
//
// Uso (na pasta backend):
//   node scripts/set-sud0.js SEU-EMAIL SUA-SENHA
// Exemplo:
//   node scripts/set-sud0.js rafael@email.com MinhaSenhaForte123
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

const email = process.argv[2];
const senha = process.argv[3];

if (!email || !senha) {
  console.error('Uso: node scripts/set-sud0.js <email> <senha>');
  console.error('Ex.: node scripts/set-sud0.js rafael@email.com MinhaSenhaForte123');
  process.exit(1);
}
if (senha.length < 6) {
  console.error('A senha precisa ter pelo menos 6 caracteres.');
  process.exit(1);
}

(async () => {
  const hash = await bcrypt.hash(senha, 10);
  const r = await pool.query(
    `UPDATE contas SET email = $1, senha_hash = $2, provider = 'email'
      WHERE is_sud0 = true
      RETURNING handle, email`,
    [email, hash]
  );
  if (!r.rows.length) {
    console.error('Conta sud0 não encontrada. Rodou o seed antes?');
    process.exit(1);
  }
  console.log('✓ Login do sud0 atualizado com sucesso.');
  console.log('  novo email (login):', r.rows[0].email);
  console.log('  nova senha: a que você digitou (guarde bem!)');
  console.log('  @handle continua: @' + r.rows[0].handle + ' (fundador anônimo)');
  await pool.end();
})().catch((e) => {
  if (e.code === '23505') console.error('Esse email já está em uso por outra conta.');
  else console.error('Erro:', e.message);
  process.exit(1);
});
