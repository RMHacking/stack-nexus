# Stack_n3xus — Backend

Primeiro backend real do Stack_n3xus: **Node + Express + PostgreSQL**.
Rede fechada por convite. Princípio: *o cliente esconde, o servidor decide.*

Nesta v1 já funciona: **autenticação (login + JWT)** e o **motor de convites**
(QR permanente + saldo + reserva de 48h, gate, árvore, premiação). Feed, grupos,
chat, desafios e reputação entram por cima daqui.

## Estrutura
```
db/schema.sql                 -- contas (auth + perfil) + motor de convites + view de saldo
scripts/migrate.js            -- aplica o schema
scripts/seed.js               -- cria o sud0 + cartão Genesis
src/
  config.js  db.js            -- config (.env) e pool
  app.js  server.js           -- app Express e boot (API + worker)
  auth/                       -- login, JWT, middlewares (requerLogin / requerSud0)
  convites/                   -- gate, service, rotas, worker de expiração
test/smoke.test.js            -- teste HTTP de ponta a ponta
```

## Rodar localmente
```bash
npm install
cp .env.example .env           # ajuste DATABASE_URL e JWT_SECRET
createdb stackn3xus            # ou use um Postgres já existente
npm run migrate                # cria as tabelas
npm run seed                   # cria o sud0 (imprime login + código do Genesis)
npm start                      # sobe a API em http://localhost:3000
# em outro terminal:
npm run smoke                  # roda o teste de ponta a ponta
```

> ✅ Testado aqui: migração, seed, e o smoke test HTTP completo — login do sud0,
> gate no Genesis, reserva, conclusão (nasce um membro), login do novo membro,
> bloqueio de gasto duplo, proteção das rotas (401/403), premiação e a lista de
> entradas do sud0. Todos passando.

## Endpoints (v1)
| Método | Rota | Quem | O quê |
|---|---|---|---|
| GET  | `/health` | público | status do serviço |
| POST | `/api/auth/login` | público | login por email+senha → JWT |
| GET  | `/api/auth/me` | token | quem sou eu |
| GET  | `/api/convite/:codigo` | público | **o gate** → onboarding·login·bloqueio |
| POST | `/api/convite/:codigo/reservar` | público | reserva de 48h |
| POST | `/api/onboarding/concluir` | público | finaliza a conta (consome slot) |
| GET  | `/api/me/convite` | membro | meu link + saldo |
| GET  | `/api/me/arvore` | membro | minha descendência |
| POST | `/api/admin/premiar` | sud0 | +N convites (mérito) |
| GET  | `/api/admin/entradas` | sud0 | quem entrou e por onde veio |

## Próximos passos
1. Ligar o protótipo (`stack-nexus-onboarding-preview.html` / `-login.html`) a estes endpoints.
2. OAuth GitHub/Google no login e no "criar acesso".
3. Endpoint do Genesis no painel do sud0.
4. Módulos seguintes: feed, grupos, chat, desafios, reputação.

## Notas de segurança já embutidas
- Senhas com **bcrypt**; sessões via **JWT**.
- **Rate-limit** no login e no gate (anti brute-force).
- **helmet** + **cors** configuráveis.
- Consumo de convite **atômico** (transação + FOR UPDATE) — sem gasto duplo.
- Código de convite **opaco e aleatório** (não derivado do handle).
