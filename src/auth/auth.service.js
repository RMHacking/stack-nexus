// Autenticação: login de membros existentes + emissão de JWT.
// (Não há cadastro público — contas nascem pelo fluxo de convite.)
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');

function emitirToken(conta) {
  return jwt.sign(
    { id: conta.id, handle: conta.handle, is_sud0: conta.is_sud0 },
    jwtSecret,
    { expiresIn: '30d' }
  );
}

// login por email + senha
async function login(pool, email, senha) {
  const { rows } = await pool.query(
    `SELECT id, handle, senha_hash, is_sud0 FROM contas WHERE email = $1`,
    [email]
  );
  if (!rows.length || !rows[0].senha_hash) return { ok: false, motivo: 'credenciais' };
  const conta = rows[0];
  const confere = await bcrypt.compare(senha, conta.senha_hash);
  if (!confere) return { ok: false, motivo: 'credenciais' };
  return { ok: true, token: emitirToken(conta), conta: { id: conta.id, handle: conta.handle, is_sud0: conta.is_sud0 } };
}

module.exports = { login, emitirToken };
