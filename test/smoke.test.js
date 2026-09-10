// Smoke test HTTP: exercita o servidor real de ponta a ponta.
// Requer o servidor no ar (npm start) e o banco migrado + seed do sud0.
const BASE = process.env.BASE || 'http://localhost:3000';
const SUD0_SENHA = process.env.SUD0_SENHA || 'sud0-master-troque';

let falhas = 0;
const A = (cond, msg) => { if (!cond) { console.error('  ✗', msg); falhas++; } else console.log('  ✓', msg); };
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const api = (p, opt = {}) => fetch(BASE + p, {
  ...opt,
  headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) },
  body: opt.body ? JSON.stringify(opt.body) : undefined,
});

(async () => {
  console.log('\n[health]');
  A((await j(await api('/health'))).body.ok === true, 'GET /health ok');

  console.log('\n[login sud0]');
  const login = await j(await api('/api/auth/login', { method: 'POST', body: { email: 'sud0@stackn3xus.dev', senha: SUD0_SENHA } }));
  A(login.status === 200 && login.body.token, 'sud0 logou e recebeu token');
  const sud0Tok = login.body.token;
  const auth = (t) => ({ Authorization: 'Bearer ' + t });

  console.log('\n[cartão Genesis do sud0]');
  const meu = await j(await api('/api/me/convite', { headers: auth(sud0Tok) }));
  A(meu.body.tipo === 'genesis', 'sud0 tem cartão Genesis');
  const genesis = meu.body.codigo;

  console.log('\n[gate no Genesis (anônimo)]');
  const gate = await j(await api('/api/convite/' + genesis));
  A(gate.body.destino === 'onboarding', 'gate (anônimo, com saldo) -> onboarding');
  A(gate.body.convidante && gate.body.convidante.handle === 'sud0', 'gate informa o convidante (@sud0)');

  console.log('\n[reservar + concluir -> nasce membro #2]');
  const rsv = await j(await api('/api/convite/' + genesis + '/reservar', { method: 'POST' }));
  A(rsv.body.ok && rsv.body.resgate_id, 'reserva de 48h criada');
  const concl = await j(await api('/api/onboarding/concluir', {
    method: 'POST',
    body: { resgateId: rsv.body.resgate_id, conta: { handle: 'k3rnel', email: 'k3rnel@teste.dev', senha: 'segredo123', trilha: 'cyber', exposicao: 'reservado' } },
  }));
  A(concl.body.ok && concl.body.membro_num, 'cadastro concluído (membro #' + concl.body.membro_num + ')');

  console.log('\n[novo membro loga e tem seu próprio convite]');
  const login2 = await j(await api('/api/auth/login', { method: 'POST', body: { email: 'k3rnel@teste.dev', senha: 'segredo123' } }));
  A(login2.body.token, 'k3rnel logou');
  const meu2 = await j(await api('/api/me/convite', { headers: auth(login2.body.token) }));
  A(meu2.body.tipo === 'padrao' && meu2.body.slots_disponiveis === 3, 'k3rnel tem link padrão com 3 convites');

  console.log('\n[gasto duplo bloqueado]');
  const dup = await j(await api('/api/onboarding/concluir', { method: 'POST', body: { resgateId: rsv.body.resgate_id, conta: { handle: 'x', senha: 'y' } } }));
  A(dup.status === 409, 'concluir o mesmo resgate de novo -> 409');

  console.log('\n[proteção das rotas]');
  A((await api('/api/me/convite')).status === 401, '/me/convite sem token -> 401');
  A((await api('/api/admin/entradas', { headers: auth(login2.body.token) })).status === 403, '/admin sem ser sud0 -> 403');

  console.log('\n[sud0 vê as entradas]');
  const ent = await j(await api('/api/admin/entradas', { headers: auth(sud0Tok) }));
  A(Array.isArray(ent.body) && ent.body.some(e => e.convidado === 'k3rnel'), 'admin/entradas lista @k3rnel convidado por @sud0');

  console.log('\n[premiar +2]');
  await j(await api('/api/admin/premiar', { method: 'POST', headers: auth(sud0Tok), body: { contaId: concl.body.conta_id, quantidade: 2, motivo: 'boas-vindas' } }));
  const meu2b = await j(await api('/api/me/convite', { headers: auth(login2.body.token) }));
  A(meu2b.body.slots_total === 5, 'k3rnel premiado +2 -> total 5');

  console.log('\n' + (falhas ? `=== ${falhas} FALHA(S) ===` : '=== TODOS OS TESTES HTTP PASSARAM ==='));
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
