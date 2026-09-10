// Boot: sobe a API e o worker de expiração das reservas.
const { criarApp } = require('./app');
const { port } = require('./config');
const { iniciar: iniciarWorker } = require('./convites/expiracao.worker');

const app = criarApp();
app.listen(port, () => {
  console.log(`[stack-nexus] API no ar em http://localhost:${port}`);
  iniciarWorker(); // varre reservas vencidas a cada 60s
});
