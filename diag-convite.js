// Diagnóstico: por qual caminho cada pessoa entrou (evento vs convite pessoal)
// Uso: node diag-convite.js Se7en musashi142857   (sem @)
require('dotenv').config();
const { pool } = require('./src/db');
(async () => {
  const alvos = process.argv.slice(2).map(h => h.replace(/^@/, '').toLowerCase());
  if (!alvos.length) { console.log('uso: node diag-convite.js @handle1 @handle2'); process.exit(0); }
  const { rows } = await pool.query(
    `SELECT c.handle, c.membro_num,
            o.handle           AS origem_conta,
            lo.handle          AS dono_do_link,
            c.evento_id,
            ev.nome            AS evento_nome,
            evc.handle         AS evento_criado_por
       FROM contas c
       LEFT JOIN contas        o  ON o.id  = c.origem_conta_id
       LEFT JOIN convite_links l  ON l.id  = c.origem_convite_link_id
       LEFT JOIN contas        lo ON lo.id = l.conta_id
       LEFT JOIN eventos       ev ON ev.id = c.evento_id
       LEFT JOIN contas        evc ON evc.id = ev.criado_por
      WHERE lower(c.handle) = ANY($1)`, [alvos]);
  if (!rows.length) { console.log('Ninguém encontrado com esses handles.'); }
  for (const r of rows) {
    console.log('\n@' + r.handle + '  (membro #' + (r.membro_num || '—') + ')');
    if (r.evento_id) {
      console.log('  → ENTROU PELO EVENTO: "' + (r.evento_nome || '?') + '"');
      console.log('    criado por: @' + (r.evento_criado_por || '?') + '  ← é quem recebe a conexão/crédito');
    } else if (r.dono_do_link) {
      console.log('  → ENTROU POR CONVITE PESSOAL de: @' + r.dono_do_link);
    } else if (r.origem_conta) {
      console.log('  → origem: @' + r.origem_conta + ' (sem link registrado)');
    } else {
      console.log('  → sem origem registrada (raiz da rede?)');
    }
  }
  await pool.end();
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
