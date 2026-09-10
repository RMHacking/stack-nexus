// Middlewares de autorização a partir do JWT.
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');

// popula req.user se houver token válido (não obriga)
function autenticacao(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, jwtSecret); } catch (_e) { /* token inválido = anônimo */ }
  }
  next();
}

function requerLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ erro: 'nao_autenticado' });
  next();
}

function requerSud0(req, res, next) {
  if (!req.user || !req.user.is_sud0) return res.status(403).json({ erro: 'acesso_negado' });
  next();
}

module.exports = { autenticacao, requerLogin, requerSud0 };
