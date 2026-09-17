// Conecta retroativamente quem já entrou ao seu convite (origem) ou ao criador do evento.
// Uso:
//   node conectar-existentes.js           -> DRY-RUN (só mostra o que faria)
//   node conectar-existentes.js aplicar   -> aplica de verdade
const { pool } = require('./src/db');
const aplicar = process.argv[2] === 'aplicar';

async function garante(a, b, client) {
  if (!a || !b || a === b) return false;
  const ex = await client.query(
    `SELECT status FROM conexoes WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1) LIMIT 1`, [a, b]);
  if (ex.rows.length && ex.rows[0].status === 'aceita') return false; // já conectados
  if (!aplicar) return true;
  await client.query(`DELETE FROM conexoes WHERE (de_id=$1 AND para_id=$2) OR (de_id=$2 AND para_id=$1)`, [a, b]);
  await client.query(`INSERT INTO conexoes (de_id, para_id, status) VALUES ($1,$2,'aceita')`, [a, b]);
  return true;
}

(async () => {
  const client = await pool.connect();
  let n = 0;
  try {
    const inv = await client.query(
      `SELECT c.id, c.handle, c.origem_conta_id, o.handle AS origem_handle
         FROM contas c JOIN contas o ON o.id = c.origem_conta_id
        WHERE c.origem_conta_id IS NOT NULL AND c.is_sud0=false
          AND c.pendente_aprovacao=false AND c.banido=false`);
    for (const r of inv.rows) {
      if (await garante(r.origem_conta_id, r.id, client)) { n++; console.log((aplicar ? '✓' : 'faria') + ' @' + r.handle + ' <-> @' + r.origem_handle); }
    }
    const ev = await client.query(
      `SELECT c.id, c.handle, e.criado_por, o.handle AS criador_handle
         FROM contas c JOIN eventos e ON e.id = c.evento_id JOIN contas o ON o.id = e.criado_por
        WHERE c.evento_id IS NOT NULL AND e.criado_por IS NOT NULL AND c.is_sud0=false
          AND c.pendente_aprovacao=false AND c.banido=false`);
    for (const r of ev.rows) {
      if (await garante(r.criado_por, r.id, client)) { n++; console.log((aplicar ? '✓' : 'faria') + ' @' + r.handle + ' <-> @' + r.criador_handle + ' (evento)'); }
    }
    console.log('\n' + (aplicar ? ('Conectados: ' + n) : ('Faria ' + n + ' conexão(oes). Se estiver certo, rode:  node conectar-existentes.js aplicar')));
  } catch (e) { console.error('erro:', e.message); process.exitCode = 1; }
  finally { client.release(); await pool.end(); }
})();
