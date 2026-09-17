// Manda um push de TESTE direto pra um handle e mostra a resposta do serviço (FCM).
// Uso: node testar-push.js <handle>
require('dotenv').config();
const webpush = require('web-push');
const { pool } = require('./src/db');
const handle = (process.argv[2] || '').replace(/^@/, '');
if (!handle) { console.error('Uso: node testar-push.js <handle>'); process.exit(1); }
if (!process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) { console.error('faltam VAPID no .env'); process.exit(1); }
webpush.setVapidDetails('mailto:sud0@stack-nexus', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
(async () => {
  const q = await pool.query(
    `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps JOIN contas c ON c.id=ps.conta_id WHERE lower(c.handle)=lower($1)`, [handle]);
  if (!q.rows.length) { console.log('sem inscrição pra @' + handle + ' (ative as notificações nessa conta primeiro)'); await pool.end(); return; }
  console.log('encontrei ' + q.rows.length + ' inscrição(ões) pra @' + handle + '. Enviando teste...\n');
  for (const s of q.rows) {
    try {
      const r = await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: '♛ Stack_n3xus', body: 'Teste de push 🔔 — se você está vendo isso, funcionou!', url: '/stack-nexus-app-final.html' }));
      console.log('ENVIADO ✓  status ' + r.statusCode + ' (201 = o serviço aceitou; deve pipocar no aparelho)');
    } catch (e) {
      console.log('FALHOU ✗  status ' + (e.statusCode || '?') + ' — ' + String(e.body || e.message || '').slice(0, 200));
    }
  }
  await pool.end();
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
