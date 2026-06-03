# AI FinOps — feature-level ROI on AI engineering spend

> Customer-facing module that lets onboarded tenants see what their AI
> features cost to build, what they cost to run, who uses them, and
> what they return. Stack-rank features by ROI; surface the ones bleeding
> tokens without usage.
>
> Four independent layers on a shared `feature_id` PK — each one degrades
> gracefully when its data source is missing. Customer enables what they
> have data for and gets partial answers; the full quartet (build cost +
> runtime cost + usage + revenue) lights up the complete ROI picture.
>
> Sister module to AI Visibility v2 — same data sources (GitHub, cloud,
> identity), same multi-tenant infra, same compliance lens. Lives at
> `/ai-finops`. Honest framing: this is engineering-spend tracking, not
> security.
>
> Brainstorm date: 2026-06-01.

## 1. Goal and success criteria

A new tenant lands on `/ai-finops`, connects their GitHub + Anthropic
Admin API, and within 10 minutes sees a ranked list of the AI features
they shipped in the last 90 days with build cost per feature, per-seat
attribution, and a confidence badge on every number.

**Success criteria:**

1. **Onboarding wedge (Layer 1 auto-discovery).** A new tenant clicks
   "Auto-discover features" and Claude Sonnet returns a draft feature
   list inferred from the last 90 days of merged PR titles + branch
   names + file paths. The user edits the list (rename, merge, split,
   delete) and confirms; the confirmed mapping persists to
   `features.github_*` rules.
2. **Build cost lights up in <10 min.** Anthropic Admin API + GitHub
   PR history are sufficient to render the dashboard for a tenant with
   no runtime instrumentation yet. The dashboard shows: cost per
   feature, cost per seat, cost over time, with `confidence: high|med|low`
   per row.
3. **Runtime cost via SDK.** A tenant who `pip install transilience-tracker`
   and wraps their LLM client sees inference cost roll up to the same
   `feature_id` within 60 seconds of the first call.
4. **Usage attaches cleanly.** A tenant who maps PostHog/Amplitude event
   names to `feature_id` sees a usage column ($ per active user, cost
   per session) appear on the same dashboard.
5. **ROI surface is honest.** The ROI tab shows revenue attribution
   only via one of four explicit methods (tier mapping / A/B / self-
   attested / engagement proxy), each with a confidence badge. No
   single "ROI number" is computed; the inputs are shown and the
   customer makes the call.
6. **The four layers fail independently.** Disconnecting GitHub doesn't
   break runtime cost; missing analytics doesn't break build cost; no
   Stripe connection doesn't block the dashboard.

## 2. Why this design

- **Layer 1 first because the rest is noise without it.** Every other
  cost-tracking tool in the market (Helicone, Langfuse, Vellum, Portkey)
  starts at the inference layer and tries to bolt feature attribution
  on later. They all stall because raw model calls don't carry feature
  semantics. We start with feature definition + mapping and let cost
  data accrue against it. This is the same pattern as CME v2's
  normalize → augment: the brain is the mapping, not the ingestion.
- **AI-inferred onboarding draft, not blank form.** PMs and eng leads
  won't sit down and define 12 features in a form. They will edit a
  draft list Claude proposed from their PR history. Onboarding
  friction is the #1 killer of products in this category.
- **Each layer degrades independently.** A tenant with only GitHub +
  Anthropic Admin connected still gets the build-cost dashboard.
  Compare to "platform" approaches that block all value until every
  integration is configured.
- **No single ROI number, ever.** Revenue attribution is genuinely
  hard. Customer trust depends on us not pretending otherwise.
  Show the inputs, label confidence, let the customer decide.
- **Build-time attribution is probabilistic and we say so.** Linking
  developer tokens to features via commit-author + branch + time
  window is best-effort. Every row carries a `confidence` field and
  the UI shows it. Pretending exactness here will burn credibility on
  the first customer who spot-checks.
- **SDK first for runtime, proxy later.** SDK preserves customer
  privacy (we never see prompts) and is a 5-line code change. Proxy
  is for tenants who already run LiteLLM and want zero-code-change
  ingest — but the privacy trade is loud and opt-in.
- **Sister module to `/ai`, not "v3"**. AI Visibility v2 is a security
  lens (shadow AI, code risks, compliance). AI FinOps is an
  engineering-spend lens. Same plumbing, different question. Forcing
  them into one route narrows both narratives.

## 3. Scope

### In scope (Slice 1)

- Layer 1 (feature definition + mapping engine) — fully shipped
- Layer 2a (build-time cost via Anthropic Admin + OpenAI Admin) —
  fully shipped
- `/ai-finops` web route with feature dashboard + drill-down
- Auto-discovery onboarding via Claude Sonnet over GitHub history
- Connector additions: Anthropic Admin API, OpenAI Admin API
- Schema: `features`, `feature_costs`, `feature_signals`
- Per-row confidence badges throughout

### In scope (Slice 2)

- Layer 2b (runtime cost via SDK)
- `transilience-tracker` SDK packages: Python (pip), Node (npm)
- LiteLLM-callback ingest endpoint (`/v1/finops/llm-call`)
- Per-tenant ingest token (separate from Cognito session)

### In scope (Slice 3)

- Layer 3 (usage from PostHog / Amplitude / Mixpanel)
- Fallback: server-log scraping for tenants without product analytics
- Usage column on the dashboard

### In scope (Slice 4)

- Layer 4 (ROI attribution via tier / A/B / self-attested / engagement)
- Stripe connector for tier mapping
- Manual attestation UI for self-reported revenue
- ROI tab with confidence-labeled methods

### Out of scope (deferred)

- Cursor / Claude Code direct telemetry — no APIs exist; CSV ingest
  is a v2 consideration
- GitHub Copilot Enterprise audit log ingest — coarse (per-seat), not
  per-token; defer until we have a customer who needs it
- AWS Bedrock / Azure OpenAI / Vertex runtime ingest via cloud
  metrics — covered indirectly by SDK; native cloud-metric ingest is
  v2
- Multi-tenant developer-token cross-attribution (one developer working
  for two customers) — flag, don't solve, in v1
- Causal-inference ROI modelling (e.g. CausalImpact) — out of scope;
  show inputs, not predictions
- Slack/email alerting for "feature X cost overrun" — natural follow-on
  for Slice 5

## 4. Architecture overview

Six components. First four are net-new; last two extend existing infra.

```
                    ┌─────────────────────────────────┐
                    │ web/src/routes/AiFinOps/        │
                    │  • FeaturesPage.tsx (new)       │
                    │  • FeatureDetailPage.tsx (new)  │
                    │  • MappingPage.tsx (new)        │
                    │  • RoiPage.tsx (new, Slice 4)   │
                    └────────────┬────────────────────┘
                                 │
                    ┌────────────▼────────────────────┐
                    │  /v1/finops/* Lambda            │
                    │  • POST /features (create)      │
                    │  • GET  /features (list)        │
                    │  • POST /features/discover      │  ── calls Claude Sonnet
                    │  • POST /features/{id}/map      │
                    │  • POST /llm-call (Slice 2)     │  ── SDK ingest endpoint
                    │  • GET  /roi (Slice 4)          │
                    └────────────┬────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       │                         │                         │
       ▼                         ▼                         ▼
┌──────────────┐         ┌────────────────┐        ┌────────────────┐
│ Aurora       │         │ EventBridge    │        │ classifier     │
│ features +   │◀────────│ scheduled rule │───────▶│ Lambda         │
│ feature_*    │         │ (6h cadence)   │        │ (LiteLLM call) │
│ tables       │         └────────────────┘        └────────────────┘
└──────────────┘                                            │
       ▲                                                    │
       │                                  ┌─────────────────┴───────────────┐
       │                                  ▼                                 ▼
       │                          ┌──────────────────┐         ┌────────────────────┐
       │                          │ ingest workers   │         │ shared LiteLLM     │
       │                          │ (one per source) │         │ wrapper (existing) │
       └──────────────────────────┤  • anthropic_ingest        └────────────────────┘
                                  │  • openai_ingest
                                  │  • github_ingest (re-use)
                                  │  • analytics_ingest
                                  │  • stripe_ingest (Slice 4)
                                  └──────────────────┘
```

**Components:**

1. **`/v1/finops/*` Lambda** — REST surface. Auth via existing Cognito
   JWT. Subject extraction follows the canonical
   `identities[0].userId → sub` pattern (CLAUDE.md). The `/llm-call`
   endpoint uses a separate per-tenant ingest token (not Cognito) so
   the SDK can ship from any process.
2. **Aurora schema additions** — `features`, `feature_signals`,
   `feature_costs`, `feature_usage`, `feature_revenue`. Schema written
   against the gotchas (PK names, `evidence_packet` for JSON, no
   `parent_id` columns, etc.).
3. **Auto-discovery classifier Lambda** — invoked by the
   `/features/discover` endpoint. Pulls the last 90 days of merged
   PRs from the tenant's connected GitHub App, batches them, calls
   Claude Sonnet via LiteLLM with a JSON-schema-constrained prompt,
   returns a proposed feature list. User confirms, system persists
   the rules.
4. **Ingest workers** — one Lambda per source (Anthropic, OpenAI,
   GitHub, analytics, Stripe). Triggered by EventBridge on a 6h
   cadence (per-tenant, per-source last-run timestamp prevents
   duplicate ingest). Each worker writes to `feature_signals` (raw
   events) and `feature_costs` (resolved feature_id + cost). The
   resolution step uses the rules in `features` to attach
   `feature_id` and `confidence`.
5. **SDK packages (Slice 2)** — `transilience-tracker-py` and
   `transilience-tracker-node`. Thin wrappers around customer's
   LLM client. Each call → background POST to `/v1/finops/llm-call`
   with `{tenant_token, feature_id_or_hint, model, tokens_in,
   tokens_out, cost_usd, latency_ms}`. The Lambda persists to
   `feature_costs` after resolving `feature_id_or_hint` (which may
   be a tag like `feature=voice-search` or null for log-only).
6. **Dashboard pages** — five routes:
   `/ai-finops` (overview ranked by cost),
   `/ai-finops/features/:id` (drill-down with build/runtime/usage
   timeline), `/ai-finops/mapping` (rules + unmapped triage queue),
   `/ai-finops/roi` (Slice 4 — revenue attribution surfaces),
   `/ai-finops/onboarding` (auto-discovery wizard).

**Adding a new cost source later = a new ingest worker + a row in the
sources catalog. No schema change, no UI change.**

## 5. Data model

Five new Aurora tables.

### `features` — canonical feature record + mapping rules

```sql
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
  -- mapping rules (any signal matching any rule resolves to this feature_id)
  github_pr_labels     TEXT[] NOT NULL DEFAULT '{}',
  github_branch_re     TEXT,
  github_path_res      TEXT[] NOT NULL DEFAULT '{}',
  product_event_names  TEXT[] NOT NULL DEFAULT '{}',
  sdk_tags             TEXT[] NOT NULL DEFAULT '{}',
                       -- e.g. ['feature=voice-search']; tenant chooses convention
  -- revenue mapping (Slice 4)
  revenue_method       TEXT,
                       -- 'tier'|'ab'|'self-attested'|'engagement'|NULL
  revenue_config       JSONB NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, name)
);
CREATE INDEX ix_features_tenant ON features (tenant_id, status);
```

### `feature_signals` — raw events ingested from sources

```sql
CREATE TABLE feature_signals (
  signal_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID REFERENCES features(feature_id),
                     -- NULL when unmapped; surfaces in /ai-finops/mapping triage
  occurred_at        TIMESTAMPTZ NOT NULL,
  source             TEXT NOT NULL,
                     -- 'github'|'anthropic'|'openai'|'cursor-csv'|'analytics'|'stripe'|'sdk'
  external_ref       TEXT,
                     -- PR number, request_id, event_id, invoice_id
  actor              TEXT,
                     -- developer email, customer user_id, NULL
  signal_kind        TEXT NOT NULL,
                     -- 'pr-merged'|'llm-call-dev'|'llm-call-runtime'|'product-event'|'invoice'
  confidence         TEXT NOT NULL DEFAULT 'high',
                     -- 'high'|'med'|'low'
  evidence_packet    JSONB NOT NULL DEFAULT '{}',
                     -- raw payload from source; queryable for forensics
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_feature_signals_tenant_time
  ON feature_signals (tenant_id, occurred_at DESC);
CREATE INDEX ix_feature_signals_feature
  ON feature_signals (feature_id, occurred_at DESC) WHERE feature_id IS NOT NULL;
CREATE INDEX ix_feature_signals_unmapped
  ON feature_signals (tenant_id, source) WHERE feature_id IS NULL;
```

### `feature_costs` — resolved cost rows (one per LLM call or invoice line)

```sql
CREATE TABLE feature_costs (
  cost_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID REFERENCES features(feature_id),
  signal_id          UUID REFERENCES feature_signals(signal_id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  phase              TEXT NOT NULL,
                     -- 'build'|'test'|'runtime'
  source             TEXT NOT NULL,
                     -- 'anthropic'|'openai'|'bedrock'|'azure-openai'|'vertex'|'sdk'
  actor              TEXT,
                     -- developer email (build) or end-user id (runtime), NULL when aggregated
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
```

### `feature_usage` — product analytics events (Slice 3)

```sql
CREATE TABLE feature_usage (
  usage_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID NOT NULL REFERENCES features(feature_id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  source             TEXT NOT NULL,
                     -- 'posthog'|'amplitude'|'mixpanel'|'server-log'
  end_user_id        TEXT NOT NULL,
                     -- the tenant's customer/user, not Shasta user
  event_name         TEXT NOT NULL,
  attrs              JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX ix_feature_usage_feature_time
  ON feature_usage (feature_id, occurred_at DESC);
CREATE INDEX ix_feature_usage_tenant_user
  ON feature_usage (tenant_id, end_user_id, occurred_at DESC);
```

### `feature_revenue` — ROI attribution rows (Slice 4)

```sql
CREATE TABLE feature_revenue (
  revenue_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
  feature_id         UUID NOT NULL REFERENCES features(feature_id),
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  method             TEXT NOT NULL,
                     -- 'tier'|'ab'|'self-attested'|'engagement'
  amount_usd         NUMERIC(12,2),
                     -- NULL when method='engagement' (proxy only)
  confidence         TEXT NOT NULL,
                     -- 'high'|'med'|'low'
  notes              TEXT,
  evidence_packet    JSONB NOT NULL DEFAULT '{}',
                     -- tier IDs, A/B cohort IDs, attester user_id, retention deltas
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(user_id)
);
CREATE INDEX ix_feature_revenue_feature_period
  ON feature_revenue (feature_id, period_start DESC);
```

**Schema notes / gotcha pre-flight:**

- All PKs end in `_id` to match the existing `findings.finding_id` /
  `scans.scan_id` / `cloud_connections.conn_id` convention. No `id`-
  only columns (matches the wow-demo sprint correction).
- Extra JSON lives in `evidence_packet` (NOT `attributes`) — matches
  the existing `findings.evidence_packet` convention.
- `feature_id` is nullable on `feature_signals` because unmapped raw
  events are first-class — they show up in the triage queue.
- `confidence` is text-typed, not enum, so we can add tiers later
  without a migration (e.g. `'high-verified'` after manual override).
- `evidence_packet` JSONB lets every row carry the raw upstream
  payload for forensics. An auditor can ask "why is this row tagged
  feature X with low confidence?" and get a real answer.

## 6. The four layers in detail

### Layer 1 — feature definition + mapping engine

The brain. Without a stable `feature_id` across systems, layers 2–4
are uncorrelated noise. Two paths to populate it:

**6.1.1 Auto-discovery (the onboarding wedge).** Customer connects
GitHub via the existing GitHub App. Backend pulls 90 days of merged
PRs (title, branch, body, file paths, label set, author, merge time).
Batches into groups of ~50, calls Claude Sonnet with a JSON-schema-
constrained prompt:

```
You are categorising merged pull requests into product features.
A "feature" is a user-facing capability that the company shipped
or worked on. Group these PRs into 3-20 features.

For each feature output:
- name (short, user-facing)
- description (one sentence)
- pr_label_match (string[])
- branch_pattern (regex)
- path_pattern (string[])
- pr_numbers (the PRs in this feature)
- confidence (high|med|low)
```

UI shows the draft list with "edit / merge / split / delete" controls.
On confirm, the rules persist to `features.github_*`. The PRs already
parsed seed `feature_signals` with `confidence='high'` for the user-
confirmed PRs and `confidence='med'` for AI-only suggestions.

**6.1.2 Continuous classification.** Every new GitHub PR webhook
runs through the rule engine: label match → branch regex match →
path regex match, in that order, first match wins. No-match PRs land
in `feature_signals` with `feature_id=NULL` and surface in the
`/ai-finops/mapping` triage queue. User can one-click "assign to X"
or "create new feature from this."

**6.1.3 Override per-signal.** Any single signal can be force-mapped
to a different feature (sets `evidence_packet.override=true` for
audit). Rules then learn — adding the override pattern to the
feature's rule set is a one-click action.

### Layer 2 — cost capture

**6.2.1 Build-time cost (Layer 2a, Slice 1).**

Sources, ranked by API quality:

| Source | API | Per-user | Per-token | Plan |
|---|---|---|---|---|
| Anthropic Admin API | Yes (`/v1/organizations/usage_report/messages`) | Yes (workspace + API key) | Yes | Primary. Daily ingest worker. |
| OpenAI Admin API | Yes (`/v1/organization/usage/completions`) | Yes (project + API key) | Yes | Primary. Daily ingest worker. |
| Cursor team | CSV export only | Yes | Coarse (req count, not tokens) | Slice 1.5: manual CSV upload route. |
| GitHub Copilot Enterprise | `/copilot/usage` audit log | Yes (seat × day) | No (seat-priced) | Slice 1.5 if customer demand. |
| Claude Code | None direct | Indirect (Anthropic key holder) | Captured via Anthropic Admin | Covered by Anthropic ingest. |

Build-time cost → feature attribution is **probabilistic**:

1. Anthropic/OpenAI ingest gives a row keyed by `actor=<api_key_email>`
   + `occurred_at` + `cost_usd`.
2. GitHub ingest tells us which feature the actor was working on at
   that time (via commits to feature branches).
3. Resolution: for each cost row, find the GitHub branch the actor
   had open commits on within ±4 hours. If exactly one feature
   matches, `confidence=high`. If two features match, split the cost
   evenly and tag `confidence=med`. If no feature matches (e.g.
   refactor on `main`), tag the cost row with `feature_id=NULL` and
   `confidence=low` — surface in an "unattributed engineering cost"
   bucket.

Every cost row carries an `evidence_packet` with the resolution
trace: which commits, which branches, which heuristic fired. The UI
shows this on drill-down. The bet: customers will trust probabilistic
numbers if we show our work.

**6.2.2 Runtime cost (Layer 2b, Slice 2).**

Two delivery options, customer picks:

| Option | Code change | Privacy | When |
|---|---|---|---|
| **SDK** (recommended) | 5 lines (wrap LLM client) | Prompts never leave customer infra | Default. |
| **Proxy** (LiteLLM) | Route change | Prompts traverse our infra | For customers who already run a proxy and want zero-code-change. |

SDK shape:

```python
from transilience_tracker import track

tracker = track(tenant_token=os.environ["TRANSILIENCE_TENANT_TOKEN"])

# wrap any LLM client
client = tracker.wrap(anthropic.Anthropic(), feature_hint="voice-search")

# normal usage — tracking happens in background
client.messages.create(model="claude-sonnet-4-6", ...)
```

Wrapper hooks `client.messages.create` (Anthropic), `client.chat.completions.create`
(OpenAI), or the LiteLLM `success_callback` pattern. Background task
POSTs to `/v1/finops/llm-call` with `{tenant_token, feature_hint,
model, tokens_in, tokens_out, cost_usd, latency_ms, occurred_at}`.
The Lambda persists to `feature_costs` after resolving `feature_hint`
against `features.sdk_tags` and `features.product_event_names`.

`tenant_token` is a separate per-tenant credential (not Cognito JWT)
because the SDK ships from any process — production servers, CI
runners, batch jobs. Stored in `tenant_ingest_tokens` table (one row
per tenant, rotatable from the dashboard).

### Layer 3 — usage capture (Slice 3)

Two ingest paths:

1. **Product analytics connectors** — OAuth-style integration with
   PostHog, Amplitude, Mixpanel. Customer maps event names → features
   one-time in `features.product_event_names`. Pull on 6h cadence,
   write to `feature_usage`. Per-source ingest worker pattern matches
   Layer 2.
2. **Server-log fallback** — for tenants without product analytics,
   we accept structured access logs via the same `/v1/finops/llm-call`-
   shaped endpoint (`/v1/finops/usage-event`). Less precise but lets
   the dashboard show *something*.

The dashboard adds a "usage" column: $ per active user, cost per
session, cost per event. The drill-down adds a usage timeline next to
the cost timeline.

### Layer 4 — ROI attribution (Slice 4)

Four explicit methods, customer picks per-feature, each with a
confidence badge:

| Method | When applicable | Confidence | Data needed |
|---|---|---|---|
| **Tier mapping** | Feature gated to a paid Stripe tier | High | Stripe connector + tier IDs in `revenue_config.tier_ids[]` |
| **A/B cohort** | Feature rolled out behind a flag with revenue tracked per cohort | High when sample size > N | Cohort IDs + `revenue_config.cohort_ids[]` |
| **Self-attestation** | PM enters "this feature drives ~$X/mo" with justification | Medium, audit-trail via `created_by` | UI form |
| **Engagement proxy** | No revenue mapping — show retention/DAU uplift only | Low for ROI (useful for product teams) | Layer 3 usage data |

**Critical: never compute a single "ROI number".** The ROI tab shows
each method that applies for a feature with its confidence badge.
Customer makes the call. This is the honest move *and* the
defensible one — pretending exactness here will burn trust on the
first audit.

## 7. UX surface

Five routes:

1. **`/ai-finops`** — overview. Sortable table: feature name, build
   cost (last 30d), runtime cost (last 30d), active users (last 30d),
   ROI method + confidence badge. Default sort: build cost desc. Two
   permanent filter chips: phase (build/runtime/all), confidence
   (high/med/low/all).
2. **`/ai-finops/features/:id`** — drill-down. Top: feature metadata
   + status + ship date. Middle: cost timeline (stacked area: build /
   test / runtime). Right rail: top-cost developers, top-usage end-
   users. Bottom: evidence trail (recent signals with confidence
   badges).
3. **`/ai-finops/mapping`** — rules + unmapped triage queue. Tabs:
   "Rules" (per-feature mapping rules editor), "Unmapped" (signals
   with `feature_id=NULL`, with assign/create-new actions).
4. **`/ai-finops/roi`** (Slice 4) — revenue attribution surfaces.
   Per-method tabs: Tier (Stripe), A/B, Self-attested, Engagement.
   Each tab shows the features using that method with their numbers
   + confidence + edit/source.
5. **`/ai-finops/onboarding`** — auto-discovery wizard. Three steps:
   connect GitHub → review draft features → confirm.

Reuses existing design tokens (the persimmon-underlined chapter-with-
period pattern from the branding work). No new visual primitives.

## 8. Slice plan

Each slice is independently shippable, demo-able, and adds a layer
without breaking the prior slices.

| Slice | Layers shipped | Demo statement |
|---|---|---|
| **1** | L1 + L2a (build cost) | "Connect GitHub + Anthropic — see what your features cost to build, ranked by spend, with confidence badges." |
| **2** | L2b (runtime cost) | "Drop in 5 lines of SDK code — see runtime token cost roll up to the same features." |
| **3** | L3 (usage) | "Connect PostHog — see cost per active user, cost per session." |
| **4** | L4 (ROI) | "Connect Stripe or attest manually — see four honest methods of revenue attribution side-by-side." |

Slice 1 is the wedge. The other three accrue value, but Slice 1
alone is a sellable product — no tool in the market today shows
build-cost-per-feature with seat attribution.

## 9. Compliance crosswalk

The AI FinOps module also tags every cost row to compliance frameworks
where applicable, via the existing CME v2 pipeline. This is the
unified-platform play:

- **NIST AI RMF GOVERN-1.4** ("AI system inventory") — `features`
  table satisfies this; `/ai-finops` is the auditor's view.
- **NIST AI RMF MEASURE-2.7** ("Cost and value of AI systems") — the
  ROI surface is literally this control.
- **ISO 42001 §8.3** ("Resource management for AI") — build + runtime
  cost tracking is direct evidence.
- **EU AI Act Article 9** ("Risk management system") — cost/usage
  tracking by feature is part of the operational record.

Findings tagged to these controls now surface real evidence from
`feature_costs` / `feature_usage` rows. Auditor asks "show me your AI
system inventory and cost tracking" → one screen.

## 10. Open questions

1. **Cursor / Claude Code attribution.** No direct API. CSV ingest
   for Cursor and commit-author correlation for Claude Code (via
   Anthropic Admin) is the best we have. Acceptable for v1?
2. **Multi-tenant developer-token cross-attribution.** One developer
   working for two customers — their Anthropic spend would attribute
   to both. Flag in UI, don't solve in v1. OK?
3. **SDK packaging.** Python first (most LLM customers); Node second.
   Skip Go/Rust until customer demand. OK?
4. **Onboarding fallback when GitHub history is sparse.** If a tenant
   has <30 PRs in 90 days, auto-discovery returns "too sparse to
   suggest features — please define manually." Acceptable?
5. **Storage growth.** `feature_costs` could grow large for high-
   volume customers (think: a tenant doing 1M LLM calls/day = 1M rows/
   day). Partition by month? Aggregate after 30 days? Defer until we
   see real volumes from a paying customer.
6. **Pricing of the AI FinOps module itself.** Free for existing
   customers as a usage driver, or a paid add-on? Argues for free
   to drive adoption; argues against because it has real ingest
   cost. Defer to commercial.

## 11. Related memories

- [[project-ai-is-a-lens]] — AI security is one more source feeding
  the unified model; same logic applies here for AI engineering spend.
- [[project-cme-v2-shipped]] — compliance crosswalk runs through the
  existing CME v2 pipeline.
- [[project-mcp-connectors-slice-1-shipped]] — OAuth + encrypted-
  token-storage pattern from MCP connectors transfers directly to the
  Stripe + product-analytics connectors here.
- [[reference-aurora-schema-gotchas]] — schema choices in §5 follow
  these (PK names, `evidence_packet` for JSON).
- [[project-integrations-mcp]] — analytics + Stripe ingest should use
  vendor MCP servers where they exist; bespoke API clients only as
  fallback.

---

*Next step: implementation plan under `docs/superpowers/plans/` for
Slice 1.*
