// Web Push — envia notificação pro celular/desktop mesmo com o app fechado.
// Resiliente: se o pacote web-push não estiver instalado ou faltar VAPID, apenas desativa (não quebra o app).
const { pool } = require('../db');
let webpush = null;
try { webpush = require('web-push'); } catch (_e) { console.warn('[push] pacote web-push nao instalado — push desativado'); }

const PUB = process.env.VAPID_PUBLIC || '';
const PRIV = process.env.VAPID_PRIVATE || '';
let ready = false;
if (webpush && PUB && PRIV) {
  try { webpush.setVapidDetails('mailto:sud0@stack-nexus', PUB, PRIV); ready = true; }
  catch (e) { console.error('[push] VAPID invalido:', e.message); }
} else if (webpush) {
  console.warn('[push] faltam VAPID_PUBLIC/VAPID_PRIVATE no .env — push desativado');
}

async function enviarPush(contaId, payload) {
  if (!ready || !contaId) return;
  let subs = [];
  try { subs = (await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE conta_id=$1', [contaId])).rows; }
  catch (_e) { return; }
  const body = JSON.stringify(payload || {});
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]); } catch (_e) {}
      }
    }
  }
}
module.exports = { enviarPush, vapidPublic: () => PUB, pushReady: () => ready };
