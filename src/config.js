// Configuração central (lê do .env).
require('dotenv').config();

module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/stackn3xus',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-troque-em-producao',
  port: Number(process.env.PORT || 3000),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  reservaHoras: 48, // janela da reserva do convite
};
