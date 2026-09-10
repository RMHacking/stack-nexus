// Aplica o schema (db/schema.sql) no banco apontado por DATABASE_URL.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] schema aplicado com sucesso.');
  await pool.end();
})().catch((e) => { console.error('[migrate] erro:', e.message); process.exit(1); });
