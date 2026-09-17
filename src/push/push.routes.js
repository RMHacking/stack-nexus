const express = require('express');
const { pool } = require('../db');
const { requerLogin } = require('../auth/middleware');
const { vapidPublic } = require('./push.service');
const router = express.Router();

// chave pública pro cliente se inscrever
router.get('/push/vapid', (_req, res) => res.json({ ok: true, publicKey: vapidPublic() }));

// salvar a inscrição de push do dispositivo
router.post('/push/inscrever', requerLogin, async (req, res) => {
  try {
    const s = req.body || {};
    if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ ok: false, erro: 'dados' });
    await pool.query(
      `INSERT INTO push_subscriptions (conta_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET conta_id=EXCLUDED.conta_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
      [req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth]);
    res.json({ ok: true });
  } catch (e) { console.error('[push/inscrever]', e.message); res.status(500).json({ ok: false, erro: 'srv' }); }
});

router.post('/push/desinscrever', requerLogin, async (req, res) => {
  try {
    const ep = (req.body || {}).endpoint;
    if (ep) await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND conta_id=$2', [ep, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false }); }
});
module.exports = router;
