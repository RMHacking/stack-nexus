const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { corsOrigin } = require('./config');
const { autenticacao } = require('./auth/middleware');
const authRoutes = require('./auth/auth.routes');
const convitesRoutes = require('./convites/convites.routes');
const feedRoutes = require('./feed/feed.routes');
const projetosRoutes = require('./projetos/projetos.routes');
const gruposRoutes = require('./grupos/grupos.routes');
const dmRoutes = require('./dm/dm.routes');
const reacoesRoutes = require('./reacoes/reacoes.routes');
const eventosRoutes = require('./eventos/eventos.routes');
const conexoesRoutes = require('./conexoes/conexoes.routes');
const notificacoesRoutes = require('./notificacoes/notificacoes.routes');

function criarApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '8mb' }));
  app.use(autenticacao); // popula req.user se houver token

  app.get('/health', (_req, res) => res.json({ ok: true, servico: 'stack-nexus-backend' }));

  app.use('/api', authRoutes);
  app.use('/api', convitesRoutes);
  app.use('/api', feedRoutes);
  app.use('/api', projetosRoutes);
  app.use('/api', gruposRoutes);
  app.use('/api', dmRoutes);
  app.use('/api', reacoesRoutes);
  app.use('/api', eventosRoutes);
  app.use('/api', conexoesRoutes);
  app.use('/api', notificacoesRoutes);

  // páginas do front servidas pelo mesmo host da API (uma URL só)
  app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res, filePath) => {
      // HTML sempre revalida (evita o navegador servir versao antiga apos deploy)
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('/', (_req, res) => res.redirect('/stack-nexus-login.html'));

  // 404
  app.use((_req, res) => res.status(404).json({ erro: 'nao_encontrado' }));
  // erros
  app.use((err, _req, res, _next) => {
    console.error('[erro]', err);
    res.status(500).json({ erro: 'erro_interno' });
  });
  return app;
}

module.exports = { criarApp };
