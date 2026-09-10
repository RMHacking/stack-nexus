// Worker: expira reservas pendentes > 48h (devolve o slot ao dono).
const { pool } = require('../db');

async function expirarReservas() {
  const r = await pool.query(
    `UPDATE resgates SET status='expirado'
      WHERE status='pendente' AND expira_em < now() RETURNING id`
  );
  if (r.rowCount) console.log(`[convites] ${r.rowCount} reserva(s) expirada(s) — slots devolvidos`);
  return r.rowCount;
}

function iniciar(intervaloMs = 60_000) {
  expirarReservas().catch(console.error);
  return setInterval(() => expirarReservas().catch(console.error), intervaloMs);
}

module.exports = { expirarReservas, iniciar };
if (require.main === module) { console.log('[convites] worker iniciado'); iniciar(); }
