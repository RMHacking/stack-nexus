// Cria a conta fundadora (sud0) e o cartão Genesis dela.
// Rode uma vez após a migração. Idempotente (não duplica).
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { criarLinkConvite } = require('../src/convites/convites.service');

const SUD0_SENHA = process.env.SUD0_SENHA || 'sud0-master-troque';

(async () => {
  const existe = await pool.query(`SELECT id FROM contas WHERE handle = 'sud0'`);
  if (existe.rows.length) {
    console.log('[seed] sud0 já existe — nada a fazer.');
    await pool.end();
    return;
  }
  const hash = await bcrypt.hash(SUD0_SENHA, 10);
  const sud0 = (await pool.query(
    `INSERT INTO contas (handle, email, senha_hash, provider, is_sud0, nome, exposicao,
                         membro_num, profundidade)
     VALUES ('sud0','sud0@stackn3xus.dev',$1,'email',true,'sud0','reservado',
             nextval('seq_membro_num'), 0)
     RETURNING id`, [hash]
  )).rows[0].id;

  const genesis = await criarLinkConvite(pool, sud0, { tipo: 'genesis', slots: 1000 });

  console.log('[seed] sud0 criado.');
  console.log('       login: sud0@stackn3xus.dev  /  senha:', SUD0_SENHA);
  console.log('       cartão Genesis (codigo):', genesis.codigo);
  await pool.end();
})().catch((e) => { console.error('[seed] erro:', e.message); process.exit(1); });
