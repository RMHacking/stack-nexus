// Pool de conexão PostgreSQL.
const { Pool } = require('pg');
const { databaseUrl } = require('./config');

// Bancos na nuvem (ex: Neon) exigem SSL; local (localhost) não.
const ehLocal = /localhost|127\.0\.0\.1|\/pgrun/.test(databaseUrl);
const usarSsl = !ehLocal && process.env.PGSSL !== 'off';

const pool = new Pool({
  connectionString: databaseUrl,
  max: 10,
  ssl: usarSsl ? { rejectUnauthorized: false } : false,
});

// helper: roda uma função dentro de uma transação
async function comTransacao(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, comTransacao };
