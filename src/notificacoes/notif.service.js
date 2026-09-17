const { enviarPush } = require('../push/push.service');

function textoPush(tipo, nome, dados){
  dados = dados || {}; var n = nome || 'Alguém';
  switch(tipo){
    case 'conexao_pedido':   return { title:'Stack_n3xus', body: n+' quer se conectar com você.' };
    case 'conexao_aceita':   return { title:'Stack_n3xus', body: n+' aceitou sua conexão.' };
    case 'conexao_convite':  return { title:'Stack_n3xus', body: n+' entrou pelo seu convite e já está conectado a você.' };
    case 'comentario':       return { title:'Stack_n3xus', body: n+' comentou no seu post.' };
    case 'comentario_thread':return { title:'Stack_n3xus', body: n+' também comentou num post seu.' };
    case 'resposta':         return { title:'Stack_n3xus', body: n+' respondeu seu comentário.' };
    case 'premiacao':        return { title:'\u265b Stack_n3xus', body: 'O sud0 te premiou com '+((dados.quantidade)||1)+' convite(s).' };
    case 'aviso':            return { title:'\u265b Stack_n3xus', body: 'Advertência do sud0. Cuidado com a conduta na rede.' };
    case 'admin':            return { title:'\u265b Stack_n3xus', body: 'Você foi nomeado Admin — guardião da comunidade.' };
    case 'entrada_pendente': return { title:'\u265b Stack_n3xus', body: (dados.handle?('@'+dados.handle):'Alguém')+' entrou pelo seu convite e aguarda sua aprovação.' };
    case 'post_novo':        return { title:'Stack_n3xus', body: n+' publicou algo novo no feed.' };
    case 'projeto_novo':     return { title:'Stack_n3xus', body: n+' publicou um novo projeto.' };
    case 'grupo_novo':       return { title:'Stack_n3xus', body: n+' criou um novo grupo.' };
    case 'comunicado':       return { title:'\u265b Stack_n3xus', body: 'Novo comunicado do Fundador.' };
    case 'mencao':           return { title:'Stack_n3xus', body: n+' mencionou você.' };
    case 'dm':               return { title: n, body: 'te mandou uma mensagem.' };
    default:                 return { title:'Stack_n3xus', body: 'Você tem uma nova notificação.' };
  }
}

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
    // dispara push pro dispositivo (best-effort, nunca quebra a notificação)
    try {
      let nome = null;
      if (ator_id) {
        const a = await pool.query('SELECT nome, handle, exposicao FROM contas WHERE id=$1', [ator_id]);
        if (a.rows[0]) nome = (a.rows[0].exposicao === 'aberto' && a.rows[0].nome) ? a.rows[0].nome : ('@' + a.rows[0].handle);
      }
      const t = textoPush(tipo, nome, dados);
      await enviarPush(destinatario_id, { title: t.title, body: t.body, url: '/stack-nexus-app-final.html' });
    } catch (_e) {}
  } catch (e) { console.error('[notificar]', tipo, String(e.message || '').slice(0, 120)); }
}

// dispara push pra uma lista de contas (sem tocar no sininho) — pra chat
async function pushPara(pool, ids, payload) {
  try {
    const { enviarPush } = require('../push/push.service');
    for (const id of ids) { try { await enviarPush(id, payload); } catch (_e) {} }
  } catch (_e) {}
}

// notifica TODA a rede (sininho + push), menos o autor — pra post/projeto/grupo/comunicado
async function notificarTodos(pool, { ator_id, tipo, ref_id = null, dados = null }) {
  try {
    await pool.query(
      `INSERT INTO notificacoes (destinatario_id, ator_id, tipo, ref_id, dados)
       SELECT id, $1, $2, $3, $4 FROM contas
        WHERE is_sud0=false AND banido=false AND pendente_aprovacao=false AND ($1::uuid IS NULL OR id <> $1::uuid)`,
      [ator_id || null, tipo, ref_id, dados ? JSON.stringify(dados) : null]);
    let nome = null;
    if (ator_id) { const a = await pool.query('SELECT nome, handle, exposicao FROM contas WHERE id=$1', [ator_id]); if (a.rows[0]) nome = (a.rows[0].exposicao === 'aberto' && a.rows[0].nome) ? a.rows[0].nome : ('@' + a.rows[0].handle); }
    const t = textoPush(tipo, nome, dados);
    const alvos = await pool.query(`SELECT id FROM contas WHERE is_sud0=false AND banido=false AND pendente_aprovacao=false AND ($1::uuid IS NULL OR id <> $1::uuid)`, [ator_id || null]);
    await pushPara(pool, alvos.rows.map(r => r.id), { title: t.title, body: t.body, url: '/stack-nexus-app-final.html' });
  } catch (e) { console.error('[notificarTodos]', tipo, String(e.message || '').slice(0, 120)); }
}

// notifica quem foi @mencionado no texto (sininho + push)
async function notificarMencoes(pool, corpo, ator_id, ref_id = null) {
  try {
    const handles = [...new Set((String(corpo || '').match(/@([A-Za-z0-9_]{2,32})/g) || []).map(h => h.slice(1).toLowerCase()))];
    if (!handles.length) return;
    const q = await pool.query(`SELECT id, handle FROM contas WHERE lower(handle)=ANY($1) AND banido=false AND pendente_aprovacao=false`, [handles]);
    for (const r of q.rows) { if (String(r.id) !== String(ator_id)) await notificar(pool, { destinatario_id: r.id, ator_id, tipo: 'mencao', ref_id }); }
  } catch (e) { console.error('[mencoes]', String(e.message || '').slice(0, 120)); }
}

module.exports = { notificar, notificarTodos, notificarMencoes, pushPara };
