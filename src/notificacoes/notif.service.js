// Cria uma notificação direcionada. Nunca notifica a própria pessoa.
// tipos: 'conexao_pedido' | 'conexao_aceita' | 'comentario' | 'premiacao'
async function notificar(pool, { destinatario_id, ator_id, tipo, ref_id = null, dados = null }) {
  try {
    if (!destinatario_id || !tipo) return;
    if (ator_id && String(ator_id) === String(destinatario_id)) return; // não notifica você mesmo
    await pool.query(
      `INSERT INTO notificacoes (destinatario_id, ator_id, tipo, ref_id, dados)
       VALUES ($1,$2,$3,$4,$5)`,
      [destinatario_id, ator_id || null, tipo, ref_id, dados ? JSON.stringify(dados) : null]
    );
  } catch (e) { console.error('[notificar]', tipo, String(e.message || '').slice(0, 120)); }
}
module.exports = { notificar };
