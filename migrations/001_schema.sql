-- ============================================================================
-- Atelier — schéma principal
-- Postgres 15+. Les montants en millimes (entier). Les crédits sont entiers.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---------------------------------------------------------------------------
-- Comptes et espaces de travail
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'seller'
                CHECK (kind IN ('seller','agency','reseller','internal')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','closed')),
  country       CHAR(2) NOT NULL DEFAULT 'TN',
  locale        TEXT NOT NULL DEFAULT 'fr',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT UNIQUE NOT NULL,
  phone          TEXT,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX wm_user_idx ON workspace_members (user_id);

-- Jetons de réinitialisation / vérification
CREATE TABLE auth_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL CHECK (purpose IN ('reset','verify','invite')),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Identité de marque
-- ---------------------------------------------------------------------------
CREATE TABLE brand_kits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  palette        JSONB NOT NULL DEFAULT '[]',
  tone           TEXT,
  logo_asset_id  UUID,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX brand_ws_idx ON brand_kits (workspace_id);
CREATE UNIQUE INDEX brand_one_default ON brand_kits (workspace_id) WHERE is_default;

-- ---------------------------------------------------------------------------
-- GRAND LIVRE DE CRÉDITS — en ajout seul
-- ---------------------------------------------------------------------------
CREATE TABLE credit_accounts (
  workspace_id  UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  balance       BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  held          BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
  lifetime_in   BIGINT NOT NULL DEFAULT 0,
  lifetime_out  BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT held_within_balance CHECK (held <= balance)
);

CREATE TABLE credit_entries (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  amount          BIGINT NOT NULL CHECK (amount <> 0),
  reason          TEXT NOT NULL CHECK (reason IN (
                    'topup_card','topup_code','topup_manual','signup_bonus',
                    'referral','generation','refund','expiry','adjustment')),
  ref_type        TEXT,
  ref_id          TEXT,
  balance_after   BIGINT NOT NULL,
  cost_usd_micros BIGINT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ce_ws_idx ON credit_entries (workspace_id, id DESC);
CREATE UNIQUE INDEX ce_ref_uq
  ON credit_entries (ref_type, ref_id, reason) WHERE ref_id IS NOT NULL;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'le grand livre est en ajout seul (table %)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ce_no_update BEFORE UPDATE ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ce_no_delete BEFORE DELETE ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE credit_holds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','committed','released')),
  ref_type      TEXT NOT NULL,
  ref_id        TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX ch_ref_uq ON credit_holds (ref_type, ref_id);
CREATE INDEX ch_expiry_idx ON credit_holds (expires_at) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- CATALOGUE D'APPLICATIONS — des données, pas du code
-- ---------------------------------------------------------------------------
CREATE TABLE ai_apps (
  id              TEXT PRIMARY KEY,
  version         INT NOT NULL DEFAULT 1,
  title           JSONB NOT NULL,
  description     JSONB NOT NULL DEFAULT '{}',
  category        TEXT NOT NULL,
  modality        TEXT NOT NULL CHECK (modality IN ('image','video','text')),
  routes          JSONB NOT NULL,
  input_schema    JSONB NOT NULL,
  prompt_template TEXT NOT NULL,
  default_params  JSONB NOT NULL DEFAULT '{}',
  credit_cost     INT NOT NULL CHECK (credit_cost > 0),
  est_seconds     INT NOT NULL DEFAULT 20,
  cacheable       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INT NOT NULL DEFAULT 100,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','live','retired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX apps_live_idx ON ai_apps (category, sort_order) WHERE status = 'live';

-- ---------------------------------------------------------------------------
-- TRAVAUX ET FICHIERS
-- ---------------------------------------------------------------------------
CREATE TABLE batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id        TEXT NOT NULL REFERENCES ai_apps(id),
  label         TEXT NOT NULL,
  total_rows    INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','paused','done','cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX batches_ws_idx ON batches (workspace_id, created_at DESC);

CREATE TABLE generation_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  app_id           TEXT NOT NULL REFERENCES ai_apps(id),
  app_version      INT NOT NULL,
  batch_id         UUID REFERENCES batches(id) ON DELETE SET NULL,
  row_index        INT,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                   ('queued','running','succeeded','failed','cancelled','blocked')),
  inputs           JSONB NOT NULL,
  resolved_prompt  TEXT,
  dedup_key        TEXT,
  served_from_cache BOOLEAN NOT NULL DEFAULT false,
  provider         TEXT,
  provider_model   TEXT,
  provider_job_id  TEXT,
  attempt          INT NOT NULL DEFAULT 0,
  credit_cost      INT NOT NULL,
  cost_usd_micros  BIGINT,
  output_text      TEXT,
  error_code       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
CREATE INDEX jobs_ws_idx     ON generation_jobs (workspace_id, created_at DESC);
CREATE INDEX jobs_batch_idx  ON generation_jobs (batch_id, row_index) WHERE batch_id IS NOT NULL;
CREATE INDEX jobs_open_idx   ON generation_jobs (status) WHERE status IN ('queued','running');
CREATE INDEX jobs_dedup_idx  ON generation_jobs (workspace_id, dedup_key)
  WHERE status = 'succeeded' AND dedup_key IS NOT NULL;

CREATE TABLE assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id        UUID REFERENCES generation_jobs(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','audio','upload')),
  storage_key   TEXT NOT NULL,
  mime          TEXT NOT NULL,
  bytes         BIGINT,
  width         INT,
  height        INT,
  duration_ms   INT,
  sha256        TEXT,
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assets_ws_idx  ON assets (workspace_id, created_at DESC);
CREATE INDEX assets_job_idx ON assets (job_id);

-- ---------------------------------------------------------------------------
-- PAIEMENTS — carte bancaire uniquement (Konnect)
-- ---------------------------------------------------------------------------
CREATE TABLE credit_packs (
  id              TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  credits         INT NOT NULL CHECK (credits > 0),
  bonus_credits   INT NOT NULL DEFAULT 0,
  price_tnd_mils  INT NOT NULL,
  sort_order      INT NOT NULL DEFAULT 100,
  active          BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  rail            TEXT NOT NULL DEFAULT 'konnect' CHECK (rail IN ('konnect','manual')),
  pack_id         TEXT REFERENCES credit_packs(id),
  credits         INT NOT NULL,
  amount_minor    INT NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'TND',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','failed','expired','refunded')),
  provider_ref    TEXT,
  checkout_url    TEXT,
  raw_callback    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX pay_ref_uq ON payments (rail, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX pay_ws_idx ON payments (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Tarifs fournisseurs — modifiables sans redéploiement
-- ---------------------------------------------------------------------------
CREATE TABLE provider_costs (
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  unit            TEXT NOT NULL CHECK (unit IN ('image','second','1k_tokens','call')),
  cost_usd_micros BIGINT NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, unit, effective_from)
);

-- ---------------------------------------------------------------------------
-- Limitation de débit (persistée, survit aux redémarrages)
-- ---------------------------------------------------------------------------
CREATE TABLE rate_events (
  id          BIGSERIAL PRIMARY KEY,
  bucket      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rate_lookup_idx ON rate_events (bucket, subject, created_at DESC);

-- Verrou consultatif pour les tâches planifiées (une seule instance les exécute)
CREATE TABLE cron_locks (
  name        TEXT PRIMARY KEY,
  locked_by   TEXT NOT NULL,
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Journal d'audit des actions sensibles
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID,
  user_id       UUID,
  action        TEXT NOT NULL,
  target        TEXT,
  detail        JSONB NOT NULL DEFAULT '{}',
  ip            INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_idx ON audit_log (workspace_id, created_at DESC);
