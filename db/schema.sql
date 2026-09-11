-- =====================================================================
-- Stack_n3xus — schema base (v1)
-- contas (auth + perfil) + motor de convites (QR permanente + saldo).
-- Princípio: o cliente esconde, o servidor decide.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- enums ----------
DO $$ BEGIN CREATE TYPE convite_tipo   AS ENUM ('padrao','genesis');                       EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE resgate_status AS ENUM ('pendente','concluido','expirado','cancelado'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE exposicao_tipo AS ENUM ('aberto','reservado');                     EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE trilha_tipo    AS ENUM ('tech','cyber','both');                    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS seq_membro_num START 1;

-- ---------- contas (identidade + perfil + posição na árvore) ----------
CREATE TABLE IF NOT EXISTS contas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text UNIQUE NOT NULL,
  email         text UNIQUE,
  senha_hash    text,                         -- null se entrou por OAuth
  provider      text NOT NULL DEFAULT 'email', -- 'email' | 'github' | 'google'
  provider_id   text,
  is_sud0       boolean NOT NULL DEFAULT false,
  -- perfil
  nome          text,
  bio           text CHECK (char_length(bio)   <= 160),
  frase         text CHECK (char_length(frase) <= 70),
  foto_url      text,
  trilha        trilha_tipo,
  exposicao     exposicao_tipo NOT NULL DEFAULT 'aberto', -- Aberto | Reservado
  reputacao     integer NOT NULL DEFAULT 0,
  -- árvore de convites (quem trouxe quem)
  membro_num             integer UNIQUE,
  origem_conta_id        uuid REFERENCES contas(id),
  origem_convite_link_id uuid,
  linhagem               text[] NOT NULL DEFAULT '{}',
  profundidade           integer NOT NULL DEFAULT 0,
  criado_em     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE contas ADD COLUMN IF NOT EXISTS capa_url text;
CREATE INDEX IF NOT EXISTS ix_contas_origem ON contas(origem_conta_id);

-- ---------- convite_links (QR fixo permanente + saldo) ----------
CREATE TABLE IF NOT EXISTS convite_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id     uuid NOT NULL UNIQUE REFERENCES contas(id) ON DELETE CASCADE,
  codigo       text NOT NULL UNIQUE,                 -- token opaco e aleatório
  tipo         convite_tipo NOT NULL DEFAULT 'padrao',
  slots_total  integer NOT NULL DEFAULT 3 CHECK (slots_total  >= 0),
  slots_usados integer NOT NULL DEFAULT 0 CHECK (slots_usados >= 0),
  criado_em    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_slots_nao_estoura CHECK (slots_usados <= slots_total)
);

DO $$ BEGIN
  ALTER TABLE contas ADD CONSTRAINT fk_contas_origem_link
    FOREIGN KEY (origem_convite_link_id) REFERENCES convite_links(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- resgates (reserva de 48h) ----------
CREATE TABLE IF NOT EXISTS resgates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  convite_link_id    uuid NOT NULL REFERENCES convite_links(id) ON DELETE CASCADE,
  convidado_conta_id uuid REFERENCES contas(id),
  status             resgate_status NOT NULL DEFAULT 'pendente',
  reservado_em       timestamptz NOT NULL DEFAULT now(),
  expira_em          timestamptz NOT NULL,
  concluido_em       timestamptz,
  ip                 inet,
  user_agent         text
);
CREATE INDEX IF NOT EXISTS ix_resgates_pendentes ON resgates (expira_em) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS ix_resgates_link      ON resgates (convite_link_id, status);

-- ---------- premiacoes (mérito -> +convites; sud0 manual) ----------
CREATE TABLE IF NOT EXISTS premiacoes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_id      uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  quantidade    integer NOT NULL CHECK (quantidade > 0),
  motivo        text,
  desafio_id    uuid,
  concedido_por uuid NOT NULL REFERENCES contas(id),
  criado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_premiacoes_conta ON premiacoes (conta_id);

-- ---------- view de saldo ----------
CREATE OR REPLACE VIEW convite_saldo AS
SELECT
  l.id AS convite_link_id, l.conta_id, l.codigo, l.tipo,
  l.slots_total, l.slots_usados,
  COALESCE(p.pendentes,0)::int                                   AS reservas_pendentes,
  (l.slots_total - l.slots_usados - COALESCE(p.pendentes,0))::int AS slots_disponiveis,
  (l.slots_total - l.slots_usados - COALESCE(p.pendentes,0)) > 0  AS ativo
FROM convite_links l
LEFT JOIN LATERAL (
  SELECT count(*) AS pendentes FROM resgates r
  WHERE r.convite_link_id = l.id AND r.status = 'pendente' AND r.expira_em > now()
) p ON true;

-- ---------- posts (StackFeed) ----------
CREATE TABLE IF NOT EXISTS posts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  autor_id  uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  corpo     text NOT NULL CHECK (char_length(corpo) BETWEEN 1 AND 500),
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_posts_criado ON posts (criado_em DESC);
-- edição e fixação (comunicado do sud0)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS editado_em timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS fixado boolean NOT NULL DEFAULT false;
-- aviso automático de novo projeto no feed
ALTER TABLE posts ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'normal';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS ref_id uuid;

-- ---------- projetos (StackProjects) ----------
CREATE TABLE IF NOT EXISTS projetos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dono_id    uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  titulo     text NOT NULL CHECK (char_length(titulo)    BETWEEN 1 AND 80),
  descricao  text NOT NULL CHECK (char_length(descricao) BETWEEN 1 AND 500),
  repo_url   text,
  stack      text[] NOT NULL DEFAULT '{}',
  fase       text NOT NULL DEFAULT 'no ar',          -- 'no ar' | 'em construção'
  trilha     trilha_tipo,                            -- herda a do dono se não informada
  criado_em  timestamptz NOT NULL DEFAULT now(),
  editado_em timestamptz
);
CREATE INDEX IF NOT EXISTS ix_projetos_dono   ON projetos (dono_id);
CREATE INDEX IF NOT EXISTS ix_projetos_criado ON projetos (criado_em DESC);

-- ---------- comentarios (discussão nos projetos: réplicas + comentários) ----------
CREATE TABLE IF NOT EXISTS comentarios (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projeto_id uuid NOT NULL REFERENCES projetos(id) ON DELETE CASCADE,
  autor_id   uuid NOT NULL REFERENCES contas(id)   ON DELETE CASCADE,
  tipo       text NOT NULL DEFAULT 'replica',       -- 'replica' | 'comentario'
  corpo      text NOT NULL CHECK (char_length(corpo) BETWEEN 1 AND 800),
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_comentarios_projeto ON comentarios (projeto_id, criado_em);

-- ---------- grupos (StackGroups) ----------
CREATE TABLE IF NOT EXISTS grupos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 60),
  descricao  text CHECK (char_length(descricao) <= 200),
  trilha     trilha_tipo,
  criador_id uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grupo_membros (
  grupo_id  uuid NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  conta_id  uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  papel     text NOT NULL DEFAULT 'membro',   -- 'admin' | 'membro' (criador = admin)
  entrou_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grupo_id, conta_id)
);
CREATE INDEX IF NOT EXISTS ix_grupo_membros_conta ON grupo_membros (conta_id);

CREATE TABLE IF NOT EXISTS grupo_mensagens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_id       uuid NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  autor_id       uuid REFERENCES contas(id) ON DELETE SET NULL,
  corpo          text NOT NULL CHECK (char_length(corpo) BETWEEN 1 AND 1000),
  removida       boolean NOT NULL DEFAULT false,
  removida_por   uuid REFERENCES contas(id),
  removida_motivo text,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_grupo_msg ON grupo_mensagens (grupo_id, criado_em);

-- ---------- StackChat 1-a-1 (DM) ----------
CREATE TABLE IF NOT EXISTS dm_mensagens (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  de_id     uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  para_id   uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  corpo     text NOT NULL CHECK (char_length(corpo) BETWEEN 1 AND 1000),
  lida      boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dm_par  ON dm_mensagens (de_id, para_id, criado_em);
CREATE INDEX IF NOT EXISTS ix_dm_para ON dm_mensagens (para_id, lida);

CREATE TABLE IF NOT EXISTS dm_bloqueios (
  bloqueador_id uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  bloqueado_id  uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bloqueador_id, bloqueado_id)
);

-- ---------- reacoes (❤️/🔥 em posts e projetos) ----------
CREATE TABLE IF NOT EXISTS reacoes (
  alvo_tipo text NOT NULL CHECK (alvo_tipo IN ('post','projeto','comentario')),
  alvo_id   uuid NOT NULL,
  autor_id  uuid NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  tipo      text NOT NULL CHECK (tipo IN ('rocket','brain','bolt')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alvo_tipo, alvo_id, autor_id)
);
CREATE INDEX IF NOT EXISTS ix_reacoes_alvo ON reacoes (alvo_tipo, alvo_id);
ALTER TABLE reacoes DROP CONSTRAINT IF EXISTS reacoes_alvo_tipo_check;
ALTER TABLE reacoes ADD  CONSTRAINT reacoes_alvo_tipo_check CHECK (alvo_tipo IN ('post','projeto','comentario'));
DELETE FROM reacoes WHERE tipo NOT IN ('rocket','brain','bolt');
ALTER TABLE reacoes DROP CONSTRAINT IF EXISTS reacoes_tipo_check;
ALTER TABLE reacoes ADD  CONSTRAINT reacoes_tipo_check CHECK (tipo IN ('rocket','brain','bolt'));

-- ---------- eventos de convite (entrada em lote, fora da árvore pessoal) ----------
-- Quem entra por um evento tem origem = o próprio evento (origem_conta_id NULL,
-- linhagem vazia, profundidade 0). Não pendura na árvore do sud0.
CREATE TABLE IF NOT EXISTS eventos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  codigo        text NOT NULL UNIQUE,
  slots_total   integer NOT NULL DEFAULT 0 CHECK (slots_total  >= 0),
  slots_usados  integer NOT NULL DEFAULT 0 CHECK (slots_usados >= 0),
  convite_bonus integer NOT NULL DEFAULT 0 CHECK (convite_bonus >= 0), -- convites que cada entrante ganha
  ativo         boolean NOT NULL DEFAULT true,
  criado_por    uuid REFERENCES contas(id),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ev_slots CHECK (slots_usados <= slots_total)
);
-- tag: por qual evento a pessoa entrou (NULL = entrou pela árvore normal)
DO $$ BEGIN
  ALTER TABLE contas ADD COLUMN evento_id uuid REFERENCES eventos(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;


-- bate-papo próprio do evento (dentro do post; sem grupo na aba Grupos)
DO $$ BEGIN
  ALTER TABLE eventos ADD COLUMN chat_ativo boolean NOT NULL DEFAULT true;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS evento_mensagens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id  uuid NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  autor_id   uuid REFERENCES contas(id) ON DELETE SET NULL,
  corpo      text NOT NULL CHECK (char_length(corpo) BETWEEN 1 AND 1000),
  removida   boolean NOT NULL DEFAULT false,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_evento_msg ON evento_mensagens (evento_id, criado_em);

-- janela de dias do evento: QR só funciona dentro do período (null = sem restrição de data)
DO $$ BEGIN ALTER TABLE eventos ADD COLUMN inicio date; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE eventos ADD COLUMN fim    date; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- remove a coluna vestigial eventos.grupo_id (o chat do evento agora é evento_mensagens);
-- a FK dela travava o "apagar grupo"
DO $$ BEGIN ALTER TABLE eventos DROP COLUMN grupo_id; EXCEPTION WHEN undefined_column THEN NULL; END $$;
