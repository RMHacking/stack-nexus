// =====================================================================
// Motor de convites — QR permanente + saldo + reserva de 48h.
// O SERVIDOR decide. Nada aqui confia no cliente.
// =====================================================================
const crypto = require('crypto');
const { reservaHoras } = require('../config');
const { notificar } = require('../notificacoes/notif.service');

function gerarCodigo() {
  return crypto.randomBytes(18).toString('base64url'); // opaco e aleatório
}

// cria o link permanente de um membro (aceita pool OU client de transação)
async function criarLinkConvite(db, contaId, { tipo = 'padrao', slots = 3 } = {}) {
  const { rows } = await db.query(
    `INSERT INTO convite_links (conta_id, codigo, tipo, slots_total)
     VALUES ($1,$2,$3,$4) RETURNING id, codigo, tipo, slots_total`,
    [contaId, gerarCodigo(), tipo, slots]
  );
  return rows[0];
}

// O GATE — decide o destino de /convite/:codigo
async function resolverGate(pool, codigo, visitanteContaId) {
  const { rows } = await pool.query(
    `SELECT s.convite_link_id, s.slots_disponiveis, s.tipo,
            c.handle AS dono_handle, c.exposicao AS dono_exposicao,
            c.nome AS dono_nome, c.is_sud0 AS dono_sud0
       FROM convite_saldo s JOIN contas c ON c.id = s.conta_id
      WHERE s.codigo = $1`,
    [codigo]
  );
  if (!rows.length) return { destino: 'bloqueio', motivo: 'invalido' };
  const link = rows[0];
  if (visitanteContaId) return { destino: 'login', motivo: 'ja_membro' };
  if (link.slots_disponiveis <= 0) return { destino: 'bloqueio', motivo: 'sem_saldo' };
  // respeita exposição do convidante (Reservado mostra só o handle)
  const convidante = link.dono_exposicao === 'aberto'
    ? { handle: link.dono_handle, nome: link.dono_nome }
    : { handle: link.dono_handle };
  return {
    destino: 'onboarding',
    convite_link_id: link.convite_link_id,
    tipo: link.tipo, // 'padrao' | 'genesis'
    convidante,
    slots_disponiveis: link.slots_disponiveis,
  };
}

// RESERVAR — cria resgate pendente de 48h (após o convidado confirmar identidade)
async function reservarSlot(pool, codigo, meta = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lk = await client.query(`SELECT id FROM convite_links WHERE codigo=$1 FOR UPDATE`, [codigo]);
    if (!lk.rows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'invalido' }; }
    const linkId = lk.rows[0].id;
    const s = await client.query(`SELECT slots_disponiveis FROM convite_saldo WHERE convite_link_id=$1`, [linkId]);
    if (s.rows[0].slots_disponiveis <= 0) { await client.query('ROLLBACK'); return { ok: false, motivo: 'sem_saldo' }; }
    const r = await client.query(
      `INSERT INTO resgates (convite_link_id, status, reservado_em, expira_em, ip, user_agent)
       VALUES ($1,'pendente', now(), now() + ($2 || ' hours')::interval, $3, $4)
       RETURNING id, expira_em`,
      [linkId, String(reservaHoras), meta.ip || null, meta.userAgent || null]
    );
    await client.query('COMMIT');
    return { ok: true, resgate_id: r.rows[0].id, expira_em: r.rows[0].expira_em };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// CONCLUIR — transação atômica: cria a conta com origem+linhagem, consome o slot.
// `conta` = { handle, email, senha_hash, provider, nome, trilha, exposicao }
async function concluirResgate(pool, { resgateId, conta }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rg = await client.query(
      `SELECT r.status, r.convite_link_id, l.conta_id AS dono_id, l.slots_total, l.slots_usados
         FROM resgates r JOIN convite_links l ON l.id = r.convite_link_id
        WHERE r.id = $1 FOR UPDATE OF l`,
      [resgateId]
    );
    if (!rg.rows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'resgate_inexistente' }; }
    const rr = rg.rows[0];
    if (rr.status !== 'pendente') { await client.query('ROLLBACK'); return { ok: false, motivo: 'resgate_' + rr.status }; }
    if (rr.slots_usados >= rr.slots_total) { await client.query('ROLLBACK'); return { ok: false, motivo: 'sem_saldo' }; }

    const dono = (await client.query(`SELECT handle, linhagem, profundidade, is_sud0 FROM contas WHERE id=$1`, [rr.dono_id])).rows[0];
    const pendente = !!dono.is_sud0; // entrada pelo convite do Fundador precisa de aprovação manual
    const linhagem = [...(dono.linhagem || []), dono.handle];
    const profundidade = (dono.profundidade || 0) + 1;

    const nova = await client.query(
      `INSERT INTO contas
         (handle, email, senha_hash, provider, nome, trilha, exposicao,
          membro_num, origem_conta_id, origem_convite_link_id, linhagem, profundidade, pendente_aprovacao)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'aberto')::exposicao_tipo,
               nextval('seq_membro_num'), $8, $9, $10, $11, $12)
       RETURNING id, membro_num`,
      [conta.handle, conta.email || null, conta.senha_hash || null, conta.provider || 'email',
       conta.nome || null, conta.trilha || null, conta.exposicao || 'aberto',
       rr.dono_id, rr.convite_link_id, linhagem, profundidade, pendente]
    );
    const novaContaId = nova.rows[0].id;

    await client.query(
      `UPDATE resgates SET status='concluido', concluido_em=now(), convidado_conta_id=$2 WHERE id=$1`,
      [resgateId, novaContaId]
    );
    await client.query(`UPDATE convite_links SET slots_usados = slots_usados + 1 WHERE id=$1`, [rr.convite_link_id]);
    const linkNovo = await criarLinkConvite(client, novaContaId, { slots: 3 });

    await client.query('COMMIT');
    if (pendente) {
      // avisa o Fundador que tem entrada esperando aprovação
      try { await notificar(pool, { destinatario_id: rr.dono_id, ator_id: novaContaId, tipo: 'entrada_pendente', dados: { handle: conta.handle } }); } catch (_e) {}
    }
    return { ok: true, conta_id: novaContaId, membro_num: nova.rows[0].membro_num, convite_codigo: linkNovo.codigo, pendente };
  } catch (e) {
    await client.query('ROLLBACK');
    // @nick ou email já em uso -> erro amigável (não 500)
    if (e.code === '23505') {
      const campo = /email/.test(e.detail || '') ? 'email' : 'handle';
      return { ok: false, motivo: campo === 'email' ? 'email_em_uso' : 'handle_em_uso' };
    }
    throw e;
  } finally { client.release(); }
}

// PREMIAR — sud0 concede +N convites (manual, auditado)
async function premiar(pool, { contaId, quantidade, motivo, desafioId, sud0Id }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO premiacoes (conta_id, quantidade, motivo, desafio_id, concedido_por)
       VALUES ($1,$2,$3,$4,$5)`,
      [contaId, quantidade, motivo || null, desafioId || null, sud0Id]
    );
    await client.query(`UPDATE convite_links SET slots_total = slots_total + $2 WHERE conta_id=$1`, [contaId, quantidade]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function meuConvite(pool, contaId) {
  const { rows } = await pool.query(
    `SELECT codigo, tipo, slots_total, slots_usados, reservas_pendentes, slots_disponiveis, ativo
       FROM convite_saldo WHERE conta_id = $1`, [contaId]
  );
  return rows[0] || null;
}

async function minhaArvore(pool, contaId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE descendencia AS (
       SELECT id, handle, membro_num, origem_conta_id, profundidade FROM contas WHERE id=$1
       UNION ALL
       SELECT c.id, c.handle, c.membro_num, c.origem_conta_id, c.profundidade
         FROM contas c JOIN descendencia d ON c.origem_conta_id = d.id
     )
     SELECT id, handle, membro_num, origem_conta_id, profundidade
       FROM descendencia WHERE id <> $1 ORDER BY profundidade, membro_num`,
    [contaId]
  );
  return rows;
}

module.exports = {
  gerarCodigo, criarLinkConvite, resolverGate, reservarSlot,
  concluirResgate, premiar, meuConvite, minhaArvore,
};
