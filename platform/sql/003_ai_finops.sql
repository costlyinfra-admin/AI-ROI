-- ============================================================
-- AI FinOps schema — Slice 1
-- ============================================================

CREATE TABLE features (
  feature_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id),
  name                 TEXT NOT NULL,
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'in-dev',
                       -- 'planning'|'in-dev'|'shipped'|'sunset'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at           TIMESTAMPTZ,
  sunset_at            TIMESTAMPTZ,
  -- mapping rules
  github_pr_labels     TEXT[] NOT NULL DEFAULT '{}',
  github_branch_re     TEXT,
  github_path_res      TEXT[] NOT NULL DEFAULT '{}',
  product_event_names  TEXT[] NOT NULL DEFAULT '{}',
  sdk_tags             TEXT[] NOT NULL DEFAULT '{}',
  -- revenue mapping (Slice 4, nullable for now)
  revenue_method       TEXT,
  revenue_config       JSONB NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, name)
);
CREATE INDEX ix_features_tenant ON features (tenant_id, status);

CREATE TABLE feature_signals (
  signal_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID REFERENCES features(feature_id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  source             TEXT NOT NULL,
  external_ref       TEXT,
  actor              TEXT,
  signal_kind        TEXT NOT NULL,
  confidence         TEXT NOT NULL DEFAULT 'high',
  evidence_packet    JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_feature_signals_tenant_time
  ON feature_signals (tenant_id, occurred_at DESC);
CREATE INDEX ix_feature_signals_feature
  ON feature_signals (feature_id, occurred_at DESC)
  WHERE feature_id IS NOT NULL;
CREATE INDEX ix_feature_signals_unmapped
  ON feature_signals (tenant_id, source)
  WHERE feature_id IS NULL;

CREATE TABLE feature_costs (
  cost_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID REFERENCES features(feature_id),
  signal_id          UUID REFERENCES feature_signals(signal_id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  phase              TEXT NOT NULL,  -- 'build'|'test'|'runtime'
  source             TEXT NOT NULL,  -- 'anthropic'|'openai'|'sdk'
  actor              TEXT,
  model              TEXT,
  tokens_in          INTEGER,
  tokens_out         INTEGER,
  cost_usd           NUMERIC(12,6) NOT NULL,
  confidence         TEXT NOT NULL DEFAULT 'high',
  evidence_packet    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_feature_costs_tenant_time
  ON feature_costs (tenant_id, occurred_at DESC);
CREATE INDEX ix_feature_costs_feature_phase
  ON feature_costs (feature_id, phase, occurred_at DESC);

-- Slice 3 placeholder (created now, written to in Slice 3)
CREATE TABLE feature_usage (
  usage_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID NOT NULL REFERENCES features(feature_id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  source             TEXT NOT NULL,
  end_user_id        TEXT NOT NULL,
  event_name         TEXT NOT NULL,
  attrs              JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_feature_usage_feature_time
  ON feature_usage (feature_id, occurred_at DESC);
CREATE INDEX ix_feature_usage_tenant_user
  ON feature_usage (tenant_id, end_user_id, occurred_at DESC);

-- Slice 4 placeholder
CREATE TABLE feature_revenue (
  revenue_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID NOT NULL REFERENCES features(feature_id),
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  method             TEXT NOT NULL,
  amount_usd         NUMERIC(12,2),
  confidence         TEXT NOT NULL,
  notes              TEXT,
  evidence_packet    JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(user_id)
);
CREATE INDEX ix_feature_revenue_feature_period
  ON feature_revenue (feature_id, period_start DESC);