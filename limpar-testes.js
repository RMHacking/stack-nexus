// limpar-testes.js — lista e apaga contas de teste com segurança.
// Uso:
//   node limpar-testes.js                       -> lista TODAS as contas
//   node limpar-testes.js apagar @nick1 @nick2   -> apaga essas contas (nunca o sud0)
// Roda contra o mesmo banco (DATABASE_URL do .env). Tudo dentro de uma transação.

const { pool } = require('./src/db');

async function listar() {
  const { rows } = await pool.query(
    `SELECT membro_num, handle, nome, is_sud0, exposicao,
            to_char(criado_em,'DD/MM HH24:MI') AS entrou
       FROM contas
      ORDER BY is_sud0 DESC, membro_num NULLS LAST, criado_em`
  );
  console.log('\n=== CONTAS NA REDE (' + rows.length + ') ===');
  for (const r of rows) {
    const tag = r.is_sud0 ? 'SUD0' : '#' + (r.membro_num == null ? '-' : r.membro_num);
    console.log(
      tag.padEnd(7) + ' @' + (r.handle || '').padEnd(18) + ' ' +
      (r.nome || '(sem nome)').padEnd(22) + ' ' + r.exposicao.padEnd(10) + ' entrou ' + r.entrou
    );
  }
  console.log('\nPara apagar as de teste:  node limpar-testes.js apagar @nick1 @nick2 ...');
  console.log('(o sud0 e sempre protegido; suas contas reais e voce que decide manter)\n');
}

async function apagar(handles) {
  const alvos = handles.map(h => h.replace(/^@/, '').toLowerCase());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, handle, is_sud0 FROM contas WHERE lower(handle) = ANY($1)`, [alvos]
    );
    const encontrados = rows.map(r => r.handle.toLowerCase());
    const naoAchou = alvos.filter(a => !encontrados.includes(a));
    if (naoAchou.length) console.log('nao encontrei: ' + naoAchou.map(x => '@' + x).join(', '));

    const paraApagar = rows.filter(r => !r.is_sud0);
    const protegidos = rows.filter(r => r.is_sud0);
    if (protegidos.length) console.log('ignorando o sud0: ' + protegidos.map(r => '@' + r.handle).join(', '));
    if (!paraApagar.length) { console.log('nada para apagar.'); await client.query('ROLLBACK'); return; }

    const ids = paraApagar.map(r => r.id);
    await client.query(`UPDATE contas SET origem_conta_id = NULL WHERE origem_conta_id = ANY($1)`, [ids]);
    await client.query(`UPDATE convite_links SET convidado_conta_id = NULL WHERE convidado_conta_id = ANY($1)`, [ids]);
    await client.query(`DELETE FROM premiacoes WHERE concedido_por = ANY($1)`, [ids]);
    const del = await client.query(`DELETE FROM contas WHERE id = ANY($1) RETURNING handle`, [ids]);

    await client.query('COMMIT');
    console.log('apagadas: ' + del.rows.map(r => '@' + r.handle).join(', '));
    console.log('(' + del.rows.length + ' conta(s) removida(s))');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('erro, nada foi apagado:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === 'apagar') {
    const handles = args.slice(1);
    if (!handles.length) console.log('diga quais: node limpar-testes.js apagar @nick1 @nick2');
    else await apagar(handles);
  } else {
    await listar();
  }
  await pool.end();
})();
