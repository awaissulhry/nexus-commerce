# Nexus Commerce Engine — Architecture Blueprint

> **Stack note.** The shipping app is Fastify + Prisma + Next.js (App Router) +
> Tailwind. This blueprint targets the requested forward stack — **NestJS,
> PostgreSQL 16 + TimescaleDB + pgvector, Redis/BullMQ, Next.js 15 / React 19 /
> TanStack** — as the v2 substrate. Where a concept already exists in the live
> code it is named inline (e.g. the existing `AmazonAdsDailyPerformance` is the
> day-grain precursor to `hourly_performance_stream`).

Five modules: (1) Product-centric data graph + Timescale core, (2) hybrid
bidding + atomic fabric, (3) AMC clean-room + cross-channel budget shifter,
(4) zero-latency TanStack workspace, (5) NL rules engine + SOV tracker.

---

## MODULE 1 — Product-Centric Unified Data Graph & TimescaleDB Core

The catalog (Product) is the root aggregate; ad networks are leaves linked
through a single bridge. Rollups are computed at the parent-ASIN level.

### 1.1 Schema (PostgreSQL 16 + TimescaleDB)

```sql
-- Extensions ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector: semantic kw clusters
CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- fuzzy SKU/name search
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enumerations -------------------------------------------------------------
CREATE TYPE ad_network    AS ENUM ('AMAZON','WALMART','GOOGLE','META','TIKTOK');
CREATE TYPE entity_kind   AS ENUM ('CAMPAIGN','AD_GROUP','AD_SET','MEDIA_GROUP');
CREATE TYPE strategy_goal AS ENUM
  ('TARGET_ACOS','TARGET_TACOS','LIQUIDATE_INVENTORY','PROTECT_ORGANIC_RANK','MAX_REACH');
CREATE TYPE fulfilment    AS ENUM ('FBA','FBM','WFS','SFP','OTHER');

-- 1) internal_products: parent ASIN <- child SKU, inventory, COGS ----------
CREATE TABLE internal_products (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_asin       TEXT,                          -- nullable for standalone
    child_asin        TEXT,
    sku               TEXT        NOT NULL,
    marketplace       TEXT        NOT NULL,          -- 'IT','DE','US',...
    title             TEXT        NOT NULL,
    -- money is integer minor units in the SKU's settlement currency
    currency          CHAR(3)     NOT NULL DEFAULT 'EUR',
    cogs_minor        BIGINT      NOT NULL DEFAULT 0 CHECK (cogs_minor >= 0),
    price_minor       BIGINT      NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    -- denormalised real-time inventory (authoritative rows in stock_levels)
    fulfilment        fulfilment  NOT NULL DEFAULT 'FBA',
    available_qty     INTEGER     NOT NULL DEFAULT 0 CHECK (available_qty >= 0),
    inbound_qty       INTEGER     NOT NULL DEFAULT 0,
    velocity_7d       NUMERIC(12,4) NOT NULL DEFAULT 0,   -- units/day trailing 7d
    -- semantic embedding of title+bullets for kw clustering / dedup
    embedding         vector(1536),
    is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sku, marketplace)
);
-- Days of supply is a generated read model (NULL when velocity is 0).
ALTER TABLE internal_products
  ADD COLUMN days_of_supply NUMERIC(12,2)
  GENERATED ALWAYS AS (
    CASE WHEN velocity_7d > 0 THEN available_qty / velocity_7d ELSE NULL END
  ) STORED;

-- 2) ad_strategies: business goals attached to products --------------------
CREATE TABLE ad_strategies (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name              TEXT        NOT NULL,
    goal              strategy_goal NOT NULL,
    -- goal params in bps / minor units for integer-exact math
    target_acos_bps   INTEGER,                       -- 3000 = 30.00%
    target_tacos_bps  INTEGER,
    max_bid_minor     BIGINT,
    min_bid_minor     BIGINT      NOT NULL DEFAULT 5, -- €0.05 floor
    daily_budget_minor BIGINT,
    -- inventory-aware throttle knobs
    dos_floor_days    INTEGER     NOT NULL DEFAULT 7,  -- start throttling below
    enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (target_acos_bps IS NULL OR target_acos_bps BETWEEN 0 AND 100000)
);

-- product <- strategy (a product may carry one active strategy per goal)
CREATE TABLE product_strategies (
    product_id   UUID NOT NULL REFERENCES internal_products(id) ON DELETE CASCADE,
    strategy_id  UUID NOT NULL REFERENCES ad_strategies(id)     ON DELETE CASCADE,
    PRIMARY KEY (product_id, strategy_id)
);

-- 3) ad_entities_bridge: product -> N network entities ---------------------
CREATE TABLE ad_entities_bridge (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id        UUID        NOT NULL REFERENCES internal_products(id) ON DELETE CASCADE,
    network           ad_network  NOT NULL,
    entity_kind       entity_kind NOT NULL,
    external_id       TEXT        NOT NULL,          -- campaignId / adGroupId / mediaId
    external_parent_id TEXT,                          -- e.g. campaign of an ad group
    account_ref       TEXT        NOT NULL,          -- profileId / customerId / adAccountId
    is_atomic         BOOLEAN     NOT NULL DEFAULT FALSE, -- single-kw (Quartile) unit
    atomic_keyword    TEXT,                           -- the term this unit isolates
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (network, external_id, entity_kind)
);

-- 4) hourly_performance_stream: TimescaleDB hypertable ---------------------
CREATE TABLE hourly_performance_stream (
    bucket_ts         TIMESTAMPTZ NOT NULL,          -- hour, UTC
    product_id        UUID        NOT NULL,
    bridge_id         UUID        NOT NULL,          -- FK logically -> ad_entities_bridge
    network           ad_network  NOT NULL,
    marketplace       TEXT        NOT NULL,
    currency          CHAR(3)     NOT NULL,
    impressions       BIGINT      NOT NULL DEFAULT 0,
    clicks            BIGINT      NOT NULL DEFAULT 0,
    conversions       BIGINT      NOT NULL DEFAULT 0,
    units             BIGINT      NOT NULL DEFAULT 0,
    spend_minor       BIGINT      NOT NULL DEFAULT 0, -- in `currency`
    sales_minor       BIGINT      NOT NULL DEFAULT 0,
    organic_rank      INTEGER,                         -- SERP rank snapshot, NULL if unknown
    sov_paid_bps      INTEGER,                         -- share-of-voice, paid
    sov_organic_bps   INTEGER,
    ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bucket_ts, bridge_id)
);
SELECT create_hypertable('hourly_performance_stream','bucket_ts',
        chunk_time_interval => INTERVAL '7 days');
-- columnar compression for chunks older than 14 days (Timescale)
ALTER TABLE hourly_performance_stream SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'product_id, network',
    timescaledb.compress_orderby   = 'bucket_ts DESC'
);
SELECT add_compression_policy('hourly_performance_stream', INTERVAL '14 days');
SELECT add_retention_policy('hourly_performance_stream',   INTERVAL '450 days');
```

### 1.2 Indexes for < 50ms parent rollups

```sql
-- Bridge fan-out: product -> entities, hot path for rollup joins.
CREATE INDEX idx_bridge_product_network
    ON ad_entities_bridge (product_id, network) INCLUDE (external_id, is_atomic);

-- Parent grouping: covering index so the planner rolls up without a heap hit.
CREATE INDEX idx_products_parent_rollup
    ON internal_products (marketplace, parent_asin)
    INCLUDE (available_qty, velocity_7d, cogs_minor)
    WHERE is_active;

-- Partial index for the liquidation cohort (low DoS) — tiny, very fast.
CREATE INDEX idx_products_low_supply
    ON internal_products (days_of_supply)
    WHERE is_active AND days_of_supply IS NOT NULL AND days_of_supply < 21;

-- Stream: product/time composite for time-windowed rollups; brin for scans.
CREATE INDEX idx_stream_product_time
    ON hourly_performance_stream (product_id, bucket_ts DESC);
CREATE INDEX idx_stream_bucket_brin
    ON hourly_performance_stream USING brin (bucket_ts);

-- pgvector: ANN for "find products semantically like this keyword cluster".
CREATE INDEX idx_products_embedding
    ON internal_products USING hnsw (embedding vector_cosine_ops);
```

A continuous aggregate collapses the hourly hypertable to a daily read model so
the grid never scans raw chunks:

```sql
CREATE MATERIALIZED VIEW daily_perf_by_product
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', bucket_ts) AS day,
       product_id, network, currency,
       sum(impressions) AS impressions, sum(clicks) AS clicks,
       sum(conversions) AS conversions, sum(spend_minor) AS spend_minor,
       sum(sales_minor) AS sales_minor
FROM hourly_performance_stream
GROUP BY 1, 2, 3, 4
WITH NO DATA;
SELECT add_continuous_aggregate_policy('daily_perf_by_product',
        start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour');
```

### 1.3 True contribution margin per SKU (raw CTE)

Combines SP-API settlement fees, COGS, and ad spend. All money is normalised to
the SKU's settlement currency in minor units; FX is applied only at display.

```sql
WITH window_bounds AS (
    SELECT (now() - INTERVAL '30 days')::timestamptz AS from_ts, now() AS to_ts
),
-- ad spend & sales rolled up from the stream at the product level
ad AS (
    SELECT s.product_id,
           sum(s.spend_minor) AS ad_spend_minor,
           sum(s.sales_minor) AS ad_sales_minor,
           sum(s.units)       AS ad_units
    FROM hourly_performance_stream s, window_bounds w
    WHERE s.bucket_ts >= w.from_ts AND s.bucket_ts < w.to_ts
    GROUP BY s.product_id
),
-- SP-API settlement: referral + FBA + storage + refunds, per SKU
fees AS (
    SELECT f.product_id,
           sum(f.referral_fee_minor)  AS referral_minor,
           sum(f.fba_fee_minor)       AS fba_minor,
           sum(f.storage_fee_minor)   AS storage_minor,
           sum(f.refund_minor)        AS refund_minor,
           sum(f.units_settled)       AS units_settled,
           sum(f.principal_minor)     AS gross_revenue_minor
    FROM sp_api_settlement_lines f, window_bounds w
    WHERE f.posted_at >= w.from_ts AND f.posted_at < w.to_ts
    GROUP BY f.product_id
)
SELECT p.id AS product_id, p.sku, p.marketplace, p.currency,
       COALESCE(fz.gross_revenue_minor,0)                          AS gross_revenue_minor,
       COALESCE(fz.units_settled,0)                                AS units,
       COALESCE(fz.units_settled,0) * p.cogs_minor                 AS total_cogs_minor,
       COALESCE(fz.referral_minor,0) + COALESCE(fz.fba_minor,0)
         + COALESCE(fz.storage_minor,0)                            AS amazon_fees_minor,
       COALESCE(fz.refund_minor,0)                                 AS refunds_minor,
       COALESCE(a.ad_spend_minor,0)                                AS ad_spend_minor,
       -- contribution margin = revenue - COGS - fees - refunds - ad spend
       ( COALESCE(fz.gross_revenue_minor,0)
         - COALESCE(fz.units_settled,0) * p.cogs_minor
         - COALESCE(fz.referral_minor,0) - COALESCE(fz.fba_minor,0)
         - COALESCE(fz.storage_minor,0)  - COALESCE(fz.refund_minor,0)
         - COALESCE(a.ad_spend_minor,0)
       )                                                           AS contribution_margin_minor,
       -- TACOS: ad spend / total revenue (bps)
       CASE WHEN COALESCE(fz.gross_revenue_minor,0) > 0
            THEN round(COALESCE(a.ad_spend_minor,0)::numeric * 10000
                       / fz.gross_revenue_minor)
            ELSE NULL END                                          AS tacos_bps
FROM internal_products p
LEFT JOIN fees fz ON fz.product_id = p.id
LEFT JOIN ad   a  ON a.product_id  = p.id
WHERE p.is_active;
```

---

## MODULE 2 — Hybrid Bidding Engine & Autonomous Atomic Fabric

### 2.1 Bidding model

Blend short- and long-window conversion rate, scale toward the strategy's target
ACoS, apply an **inventory-elasticity throttle** that decays the bid
exponentially as days-of-supply approach zero, and add a bounded intraday
correction from the live hourly stream.

$$
CR_{blend} = \alpha \cdot CR_{7d} + (1-\alpha)\cdot CR_{30d}, \qquad \alpha = 0.65
$$

$$
Bid_{base} = AOV \cdot CR_{blend} \cdot \frac{ACoS_{target}}{1}
$$

Inventory elasticity — multiplier $\in (0,1]$, $\approx 1$ when supply is deep,
collapsing toward $0$ as $DoS \to 0$ (steepness $k$, floor day $d_0$):

$$
\theta_{inv}(DoS) = 1 - e^{-\,k\,\max(0,\;DoS - d_0)}, \qquad k = 0.18,\; d_0 = 7
$$

Bounded intraday correction from the current hour vs. trailing baseline ACoS,
clamped to $\pm\delta$ so a single noisy hour can't whipsaw the bid:

$$
\theta_{intraday} = \mathrm{clamp}\!\left(1 + \gamma\cdot\frac{ACoS_{target}-ACoS_{1h}}{ACoS_{target}},\; 1-\delta,\; 1+\delta\right),
\quad \gamma=0.5,\ \delta=0.25
$$

Final bid, clamped to the strategy's floor/cap:

$$
Bid_{new} = \mathrm{clamp}\!\big(Bid_{base}\cdot\theta_{inv}\cdot\theta_{intraday},\; Bid_{min},\; Bid_{max}\big)
$$

### 2.2 `bidding-engine.service.ts` (NestJS + BullMQ, throttle-safe)

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Pool } from 'pg';

export interface BidContext {
  bridgeId: string;
  externalId: string;          // keyword/target id at the network
  accountRef: string;          // profileId
  currentBidMinor: number;
  aov_minor: number;
  cr7d: number;
  cr30d: number;
  acosTargetBps: number;       // 3000 = 30%
  acos1hBps: number | null;    // live hour, null when no traffic
  daysOfSupply: number | null;
  bidMinMinor: number;
  bidMaxMinor: number;
}

const ALPHA = 0.65, K = 0.18, D0 = 7, GAMMA = 0.5, DELTA = 0.25;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

@Injectable()
export class BiddingEngineService {
  private readonly log = new Logger(BiddingEngineService.name);
  constructor(
    @InjectQueue('ads-write') private readonly writeQueue: Queue,
    private readonly pg: Pool,
  ) {}

  /** Pure, unit-testable bid computation (integer minor units in/out). */
  computeBid(c: BidContext): number {
    const crBlend = ALPHA * c.cr7d + (1 - ALPHA) * c.cr30d;
    const acosTarget = c.acosTargetBps / 10000;
    const bidBase = c.aov_minor * crBlend * acosTarget;

    const thetaInv = c.daysOfSupply == null
      ? 1
      : 1 - Math.exp(-K * Math.max(0, c.daysOfSupply - D0));

    let thetaIntra = 1;
    if (c.acos1hBps != null && c.acosTargetBps > 0) {
      const acos1h = c.acos1hBps / 10000;
      thetaIntra = clamp(
        1 + GAMMA * (acosTarget - acos1h) / acosTarget,
        1 - DELTA, 1 + DELTA,
      );
    }
    const raw = Math.round(bidBase * thetaInv * thetaIntra);
    return clamp(raw, c.bidMinMinor, c.bidMaxMinor);
  }

  /** Evaluate a batch and enqueue only material changes (idempotent jobs). */
  async optimizeBatch(contexts: BidContext[]): Promise<{ queued: number }> {
    let queued = 0;
    for (const c of contexts) {
      const next = this.computeBid(c);
      // 2% deadband: skip churn-y micro-moves and protect the API budget.
      if (Math.abs(next - c.currentBidMinor) * 100 < c.currentBidMinor * 2) continue;
      await this.writeQueue.add(
        'set-keyword-bid',
        { bridgeId: c.bridgeId, externalId: c.externalId,
          accountRef: c.accountRef, bidMinor: next, prevBidMinor: c.currentBidMinor },
        {
          jobId: `bid:${c.externalId}:${next}`,        // dedupe identical moves
          attempts: 6,
          backoff: { type: 'exponential', delay: 1000 }, // 1s,2s,4s,…32s
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
      queued++;
    }
    this.log.log(`optimizeBatch: evaluated=${contexts.length} queued=${queued}`);
    return { queued };
  }
}
```

The worker translates a 429 into a retryable error so BullMQ's exponential
backoff (plus the `Retry-After` header) governs the API rate, and a token-bucket
limiter caps concurrency per Amazon profile:

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('ads-write', { concurrency: 4, limiter: { max: 10, duration: 1000 } })
export class AdsWriteWorker extends WorkerHost {
  constructor(private readonly amazon: AmazonAdsClient) { super(); }

  async process(job: Job): Promise<void> {
    const { externalId, accountRef, bidMinor } = job.data;
    try {
      await this.amazon.updateKeywordBid(accountRef, externalId, bidMinor / 100);
    } catch (err: any) {
      if (err?.statusCode === 429) {
        const retryAfterMs = Number(err.headers?.['retry-after'] ?? 0) * 1000;
        if (retryAfterMs > 0) await job.moveToDelayed(Date.now() + retryAfterMs);
        throw new Error('throttled-429');     // let BullMQ backoff own the retry
      }
      throw err;                              // non-retryable → DLQ after attempts
    }
  }
}
```

### 2.3 Quartile-style atomic campaign provisioning

When a high-priority keyword is added, ensure an isolated single-keyword
campaign→ad group→keyword structure exists; otherwise create it (v3 SP). Every
hop is recorded in `ad_entities_bridge` so the fabric stays idempotent.

```typescript
@Injectable()
export class AtomicFabricService {
  constructor(private readonly amazon: AmazonAdsClient, private readonly pg: Pool) {}

  async ensureAtomic(productId: string, accountRef: string, keyword: string,
                     matchType: 'EXACT' | 'PHRASE', strategy: AdStrategy): Promise<string> {
    const existing = await this.pg.query(
      `SELECT external_id FROM ad_entities_bridge
        WHERE product_id = $1 AND network = 'AMAZON' AND is_atomic
          AND lower(atomic_keyword) = lower($2) AND entity_kind = 'AD_GROUP' LIMIT 1`,
      [productId, keyword]);
    if (existing.rowCount) return existing.rows[0].external_id;

    const prod = await this.product(productId);
    const slug = keyword.replace(/\s+/g, '-').slice(0, 40);

    // 1) campaign (manual, single-purpose, strategy budget)
    const campaignId = await this.amazon.createCampaign(accountRef, {
      name: `ATOMIC | ${prod.sku} | ${matchType} | ${slug}`,
      targetingType: 'MANUAL', state: 'enabled',
      dailyBudget: (strategy.daily_budget_minor ?? 1000) / 100,
      biddingStrategy: 'autoForSales',
    });
    // 2) ad group seeded at the strategy floor
    const adGroupId = await this.amazon.createAdGroup(accountRef, {
      campaignId, name: slug, defaultBid: strategy.min_bid_minor / 100, state: 'enabled',
    });
    // 3) product ad + 4) the one keyword
    await this.amazon.createProductAd(accountRef, { campaignId, adGroupId, sku: prod.sku });
    const keywordId = await this.amazon.createKeyword(accountRef, {
      campaignId, adGroupId, keywordText: keyword, matchType, bid: strategy.min_bid_minor / 100,
    });

    // 5) record the whole structure in the bridge (single transaction)
    const tx = await this.pg.connect();
    try {
      await tx.query('BEGIN');
      for (const [kind, extId, parent] of [
        ['CAMPAIGN', campaignId, null], ['AD_GROUP', adGroupId, campaignId],
      ] as const) {
        await tx.query(
          `INSERT INTO ad_entities_bridge
             (product_id, network, entity_kind, external_id, external_parent_id,
              account_ref, is_atomic, atomic_keyword)
           VALUES ($1,'AMAZON',$2,$3,$4,$5,TRUE,$6)
           ON CONFLICT (network, external_id, entity_kind) DO NOTHING`,
          [productId, kind, extId, parent, accountRef, keyword]);
      }
      await tx.query('COMMIT');
    } catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }

    return keywordId;
  }

  private async product(id: string) {
    const r = await this.pg.query('SELECT sku FROM internal_products WHERE id=$1', [id]);
    if (!r.rowCount) throw new Error(`product ${id} not found`);
    return r.rows[0] as { sku: string };
  }
}
```

---

## MODULE 3 — AMC Clean Room Orchestration & Cross-Channel Budget Shifter

### 3.1 AMC workflow runner (MTA overlap: SP × DSP)

AMC executes async: create a workflow execution, poll to `SUCCEEDED`, download
the result from the signed S3 URI. The SQL computes path-to-purchase overlap
between Sponsored Products and DSP.

```typescript
const MTA_OVERLAP_SQL = `
WITH conv AS (
  SELECT user_id, conversion_id, conversion_event_dt
  FROM amazon_attributed_events_by_conversion_time
  WHERE conversion_event_dt BETWEEN :start AND :end AND total_purchases > 0
),
touch AS (
  SELECT user_id, ad_product_type, event_dt
  FROM dsp_impressions
  UNION ALL
  SELECT user_id, 'SPONSORED_PRODUCTS' AS ad_product_type, impression_dt AS event_dt
  FROM sponsored_ads_traffic
)
SELECT
  count(DISTINCT c.conversion_id)                              AS conversions,
  count(DISTINCT CASE WHEN t.ad_product_type='SPONSORED_PRODUCTS'
                      THEN c.conversion_id END)                AS sp_assisted,
  count(DISTINCT CASE WHEN t.ad_product_type LIKE 'DSP%'
                      THEN c.conversion_id END)                AS dsp_assisted,
  count(DISTINCT CASE WHEN has_sp AND has_dsp
                      THEN c.conversion_id END)                AS sp_and_dsp_overlap
FROM conv c
JOIN (
  SELECT user_id,
         bool_or(ad_product_type='SPONSORED_PRODUCTS') AS has_sp,
         bool_or(ad_product_type LIKE 'DSP%')          AS has_dsp
  FROM touch GROUP BY user_id
) u ON u.user_id = c.user_id
LEFT JOIN touch t ON t.user_id = c.user_id AND t.event_dt <= c.conversion_event_dt
GROUP BY 1;`;

export class AmcOrchestratorService {
  constructor(private readonly amc: AmcApiClient) {}

  async runMtaOverlap(instanceId: string, start: string, end: string) {
    const exec = await this.amc.createWorkflowExecution(instanceId, {
      sqlQuery: MTA_OVERLAP_SQL,
      parameterValues: { start, end },
      outputFormat: 'CSV',
    });
    const id = exec.workflowExecutionId;

    // Poll with capped exponential backoff until terminal.
    for (let attempt = 0, delay = 2000; attempt < 40; attempt++) {
      const st = await this.amc.getWorkflowExecution(instanceId, id);
      if (st.status === 'SUCCEEDED') {
        const csv = await this.amc.downloadResult(st.outputS3URI);
        return this.parseOverlap(csv);
      }
      if (st.status === 'FAILED' || st.status === 'CANCELLED') {
        throw new Error(`AMC execution ${id} -> ${st.status}: ${st.statusReason ?? ''}`);
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 30000);
    }
    throw new Error(`AMC execution ${id} did not finish in budget`);
  }

  private parseOverlap(csv: string) {
    const [header, row] = csv.trim().split('\n');
    const cols = header.split(','); const vals = row.split(',');
    const o = Object.fromEntries(cols.map((c, i) => [c.trim(), Number(vals[i])]));
    const incremental = o.dsp_assisted - o.sp_and_dsp_overlap; // DSP-only conversions
    return { ...o, dsp_incremental_conversions: incremental };
  }
}
```

### 3.2 Cross-channel budget shifter (Google PMax → Amazon SP)

All comparisons happen in a **single base currency** (the org's reporting
currency); each network's spend/sales are converted via a dated FX table before
the ROAS comparison, then the shift amount is converted back to each network's
billing currency before the write.

```typescript
const BASE = 'EUR';

export class BudgetShifterService {
  constructor(private readonly google: GoogleAdsClient, private readonly amazon: AmazonAdsClient,
              private readonly fx: FxService, private readonly pg: Pool) {}

  async rebalance(productId: string, opts = { pmaxRoasFloor: 2.0, spRoasStrong: 4.0, shiftPct: 0.20 }) {
    const rows = (await this.pg.query(
      `SELECT network, currency, sum(spend_minor) spend, sum(sales_minor) sales
         FROM hourly_performance_stream
        WHERE product_id=$1 AND bucket_ts >= now() - INTERVAL '7 days'
        GROUP BY network, currency`, [productId])).rows;

    const norm = await Promise.all(rows.map(async r => {
      const rate = await this.fx.rateOn(r.currency, BASE, new Date());
      const spend = Number(r.spend) * rate, sales = Number(r.sales) * rate;
      return { network: r.network, currency: r.currency, spend,
               roas: spend > 0 ? sales / spend : 0 };
    }));

    const g = norm.find(n => n.network === 'GOOGLE');
    const a = norm.find(n => n.network === 'AMAZON');
    if (!g || !a) return { shifted: false, reason: 'missing-channel' };

    if (g.roas < opts.pmaxRoasFloor && a.roas >= opts.spRoasStrong) {
      const shiftBase = g.spend * opts.shiftPct;                 // in BASE
      const cutGoogle = shiftBase / await this.fx.rateOn(g.currency, BASE, new Date());
      const addAmazon = shiftBase / await this.fx.rateOn(a.currency, BASE, new Date());
      await this.google.adjustDailyBudget(productId, -cutGoogle);   // billed in g.currency
      await this.amazon.adjustDailyBudget(productId, +addAmazon);   // billed in a.currency
      return { shifted: true, baseShifted: shiftBase, cutGoogle, addAmazon,
               gRoas: g.roas, aRoas: a.roas };
    }
    return { shifted: false, reason: 'thresholds-not-met', gRoas: g.roas, aRoas: a.roas };
  }
}
```

### 3.3 Multi-currency / multi-timezone correctness

- **Storage:** every money column is `BIGINT` minor units **in the row's own
  `currency`**; never mix currencies in a column. Timestamps are `TIMESTAMPTZ`
  stored in **UTC** (`bucket_ts`).
- **FX:** a dated `fx_rates(base, quote, rate, as_of_date)` table; conversion is
  applied at **read/compare time**, never written back, so historical rows stay
  immutable and auditable. Cross-channel ROAS is computed in one BASE currency.
- **Timezone:** ingest in UTC; the path-to-purchase visualiser converts to the
  **marketplace's local zone** for display (Amazon IT → `Europe/Rome`, Google US
  → `America/New_York`) using `AT TIME ZONE 'UTC' AT TIME ZONE :zone` — the
  double-cast that avoids the inversion trap. "Today" is resolved per-marketplace,
  so an IT and a US row on the same wall-clock day land in their correct buckets.

---

## MODULE 4 — Zero-Latency High-Density Workspace UI

### 4.1 Master grid (TanStack Table v8 + react-virtual, parent-child rollup)

```tsx
'use client';
import { useMemo, useRef, useState, useCallback } from 'react';
import {
  useReactTable, getCoreRowModel, getExpandedRowModel,
  flexRender, type ColumnDef, type ExpandedState, type RowSelectionState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface PerfRow {
  id: string; kind: 'PARENT' | 'CHILD' | 'CAMPAIGN'; label: string;
  acosBps: number | null; spendMinor: number; salesMinor: number;
  daysOfSupply: number | null; bidMinor?: number; subRows?: PerfRow[];
}

const eur = (m?: number | null) => m == null ? '—' :
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(m / 100);

export function MasterGrid({ data, onCommitBid }: {
  data: PerfRow[]; onCommitBid: (rowId: string, bidMinor: number) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const columns = useMemo<ColumnDef<PerfRow>[]>(() => [
    {
      id: 'select', size: 36, enableResizing: false,
      header: ({ table }) => (
        <input type="checkbox" checked={table.getIsAllRowsSelected()}
               onChange={table.getToggleAllRowsSelectedHandler()} />
      ),
      cell: ({ row }) => (
        <input type="checkbox" checked={row.getIsSelected()}
               onChange={row.getToggleSelectedHandler()} />
      ),
    },
    {
      accessorKey: 'label', header: 'Product / Entity', size: 320,
      cell: ({ row, getValue }) => (
        <div style={{ paddingLeft: row.depth * 18 }} className="flex items-center gap-1.5 truncate">
          {row.getCanExpand() && (
            <button onClick={row.getToggleExpandedHandler()}
                    className="text-slate-400 hover:text-slate-700 w-4">
              {row.getIsExpanded() ? '▾' : '▸'}
            </button>
          )}
          <span className={row.depth === 0 ? 'font-medium' : 'text-slate-600'}>{getValue<string>()}</span>
        </div>
      ),
    },
    { accessorKey: 'spendMinor', header: 'Spend', size: 110,
      cell: ({ getValue }) => <span className="tabular-nums">{eur(getValue<number>())}</span> },
    { accessorKey: 'salesMinor', header: 'Sales', size: 110,
      cell: ({ getValue }) => <span className="tabular-nums">{eur(getValue<number>())}</span> },
    { accessorKey: 'acosBps', header: 'ACoS', size: 90,
      cell: ({ getValue }) => { const v = getValue<number | null>();
        return <span className="tabular-nums">{v == null ? '—' : `${(v/100).toFixed(1)}%`}</span>; } },
    { id: 'bid', header: 'Bid', size: 100,
      cell: ({ row }) => row.original.bidMinor == null ? null :
        <BidCell rowId={row.original.id} bidMinor={row.original.bidMinor} onCommit={onCommitBid} /> },
  ], [onCommitBid]);

  const table = useReactTable({
    data, columns,
    state: { expanded, rowSelection },
    onExpandedChange: setExpanded, onRowSelectionChange: setRowSelection,
    getSubRows: r => r.subRows, getRowId: r => r.id,
    enableRowSelection: true, enableSubRowSelection: false,
    getCoreRowModel: getCoreRowModel(), getExpandedRowModel: getExpandedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length, getScrollElement: () => parentRef.current,
    estimateSize: () => 30, overscan: 12,
  });

  return (
    <div ref={parentRef} className="relative overflow-auto h-[calc(100vh-180px)] border border-slate-200 rounded-lg">
      <table className="grid text-[13px] leading-tight w-full">
        <thead className="grid sticky top-0 z-20 bg-slate-50 text-slate-500 text-[12px]">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id} className="flex w-full">
              {hg.headers.map(h => (
                <th key={h.id} style={{ width: h.getSize() }}
                    className={`flex items-center px-2 py-1.5 font-medium ${h.id==='select'||h.column.id==='label' ? 'sticky left-0 z-30 bg-slate-50' : ''}`}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="grid relative" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map(vi => {
            const row = rows[vi.index];
            return (
              <tr key={row.id} data-index={vi.index}
                  ref={node => rowVirtualizer.measureElement(node)}
                  className={`flex absolute w-full border-b border-slate-100 hover:bg-slate-50 ${row.getIsSelected() ? 'bg-blue-50/60' : ''}`}
                  style={{ transform: `translateY(${vi.start}px)` }}>
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id} style={{ width: cell.column.getSize() }}
                      className={`flex items-center px-2 py-1 ${cell.column.id==='select'||cell.column.id==='label' ? 'sticky left-0 z-10 bg-inherit' : ''}`}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

### 4.2 Optimistic inline edit (React 19 — `useOptimistic` + `useTransition`)

```tsx
'use client';
import { useOptimistic, useState, useTransition } from 'react';

export function BidCell({ rowId, bidMinor, onCommit }: {
  rowId: string; bidMinor: number; onCommit: (rowId: string, bidMinor: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(bidMinor, (_p, n: number) => n);

  const commit = (raw: string) => {
    const next = Math.round(parseFloat(raw) * 100);
    setEditing(false);
    if (!Number.isFinite(next) || next === optimistic) return;
    startTransition(async () => {
      setOptimistic(next);                       // immediate visual update
      try { await onCommit(rowId, next); setError(false); }
      catch { setError(true); }                  // useOptimistic auto-reverts on throw
    });
  };

  if (editing) return (
    <input autoFocus type="number" step="0.01" defaultValue={(optimistic / 100).toFixed(2)}
           onBlur={e => commit(e.target.value)}
           onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
                             if (e.key === 'Escape') setEditing(false); }}
           className="w-16 px-1 py-0.5 text-[13px] tabular-nums rounded border border-blue-400 outline-none" />
  );
  return (
    <button onClick={() => setEditing(true)}
            className={`tabular-nums px-1 rounded transition-colors decoration-dotted
              ${isPending ? 'bg-blue-50 text-blue-600 animate-pulse'
                : error ? 'bg-rose-50 text-rose-600 ring-1 ring-rose-300'
                : 'hover:underline'}`}
            title={error ? 'Save failed — reverted' : 'Click to edit bid'}>
      €{(optimistic / 100).toFixed(2)}{error && ' ⚠'}
    </button>
  );
}
```

### 4.3 Bulk Action Drawer (slides up on multi-select) + Tailwind v4

```tsx
'use client';
export function ActionDrawer({ count, onClear, onBulkBid, onPause }: {
  count: number; onClear: () => void;
  onBulkBid: (pct: number) => void; onPause: () => void;
}) {
  return (
    <div aria-hidden={count === 0}
         className={`fixed inset-x-0 bottom-0 z-50 transition-transform duration-200 ease-out
           ${count > 0 ? 'translate-y-0' : 'translate-y-full'}`}>
      <div className="mx-auto max-w-5xl mb-4 flex items-center gap-3 rounded-xl border
                      border-slate-200 bg-white/95 backdrop-blur px-4 py-3 shadow-2xl">
        <span className="text-sm font-medium text-slate-700">{count} selected</span>
        <span className="h-5 w-px bg-slate-200" />
        <button onClick={() => onBulkBid(0.10)} className="px-2.5 py-1 text-sm rounded-md border border-blue-300 text-blue-700 hover:bg-blue-50">Bid +10%</button>
        <button onClick={() => onBulkBid(-0.10)} className="px-2.5 py-1 text-sm rounded-md border border-blue-300 text-blue-700 hover:bg-blue-50">Bid −10%</button>
        <button onClick={onPause} className="px-2.5 py-1 text-sm rounded-md border border-amber-300 text-amber-700 hover:bg-amber-50">Pause</button>
        <button onClick={onClear} className="ml-auto text-sm text-slate-400 hover:text-slate-600">Clear</button>
      </div>
    </div>
  );
}
```

```css
/* app/globals.css — Tailwind v4 CSS-first config */
@import "tailwindcss";
@theme {
  --font-size-grid: 0.8125rem;      /* 13px high-density cells */
  --color-grid-head: oklch(0.98 0 0);
  --spacing-row: 1.875rem;          /* 30px virtualized row height */
}
@layer components {
  .grid-cell { font-size: var(--font-size-grid); line-height: 1.1; }
}
```

---

## MODULE 5 — Natural-Language Rules Engine & SOV Tracker

### 5.1 NL rule parser → execution tree

Tokenise → parse to an AST (`if`/`and`/`or`/`then`/`else`) → evaluate against a
metric context. Metrics, operators, and actions are whitelisted, so no
arbitrary expressions execute.

```typescript
type Cmp = '>' | '<' | '>=' | '<=' | '==' | '!=';
type Cond = { metric: string; op: Cmp; value: number };
type BoolNode = { kind: 'and' | 'or'; nodes: BoolNode[] } | { kind: 'leaf'; cond: Cond };
type Action = { verb: string; arg?: number };
export type RuleTree = { when: BoolNode; then: Action[]; otherwise: Action[] };

const METRICS = new Set(['Hourly_ACoS','Current_Inventory_Days','ROAS','CR_7d','SOV_Paid','Spend','CTR']);
const ACTIONS = new Set(['Reduce_Bid_By','Increase_Bid_By','Set_Bid','Pause','Maintain_Pacing','Override_Bid_To']);

export function parseRule(input: string): RuleTree {
  const m = /^\s*IF\s+(.+?)\s+THEN\s+(.+?)(?:\s+ELSE\s+(.+))?\s*$/is.exec(input);
  if (!m) throw new Error('Rule must be: IF <conditions> THEN <actions> [ELSE <actions>]');
  return { when: parseBool(m[1]), then: parseActions(m[2]), otherwise: m[3] ? parseActions(m[3]) : [] };
}

function parseBool(s: string): BoolNode {
  // OR binds looser than AND
  const ors = splitTop(s, /\bOR\b/i);
  if (ors.length > 1) return { kind: 'or', nodes: ors.map(parseBool) };
  const ands = splitTop(s, /\bAND\b/i);
  if (ands.length > 1) return { kind: 'and', nodes: ands.map(parseBool) };
  return { kind: 'leaf', cond: parseCond(s) };
}

function parseCond(s: string): Cond {
  const m = /\[?\s*([A-Za-z_0-9]+)\s*(>=|<=|==|!=|>|<)\s*([0-9.]+)\s*%?\s*\]?/.exec(s);
  if (!m) throw new Error(`Bad condition: ${s}`);
  const [, metric, op, raw] = m;
  if (!METRICS.has(metric)) throw new Error(`Unknown metric: ${metric}`);
  const pct = /%/.test(s);
  return { metric, op: op as Cmp, value: pct ? Number(raw) / 100 : Number(raw) };
}

function parseActions(s: string): Action[] {
  return splitTop(s, /\bAND\b/i).map(a => {
    const m = /\[?\s*([A-Za-z_]+)(?:\s+([0-9.]+)\s*%?)?\s*\]?/.exec(a);
    if (!m || !ACTIONS.has(m[1])) throw new Error(`Unknown action: ${a}`);
    return { verb: m[1], arg: m[2] != null ? Number(m[2]) : undefined };
  });
}

// split on a delimiter regex but not inside [...] brackets
function splitTop(s: string, delim: RegExp): string[] {
  const parts: string[] = []; let depth = 0, last = 0;
  const re = new RegExp(delim.source, 'gi'); let mm: RegExpExecArray | null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') depth++; else if (s[i] === ']') depth--;
  }
  if (depth !== 0) return [s];                  // unbalanced → treat as atom
  while ((mm = re.exec(s))) {
    const before = s.slice(0, mm.index);
    if (((before.match(/\[/g) || []).length) === ((before.match(/\]/g) || []).length)) {
      parts.push(s.slice(last, mm.index)); last = mm.index + mm[0].length;
    }
  }
  parts.push(s.slice(last));
  return parts.map(p => p.trim()).filter(Boolean);
}

export function evaluate(tree: RuleTree, ctx: Record<string, number>): Action[] {
  const test = (n: BoolNode): boolean =>
    n.kind === 'leaf' ? cmp(ctx[n.cond.metric], n.cond.op, n.cond.value)
    : n.kind === 'and' ? n.nodes.every(test) : n.nodes.some(test);
  return test(tree.when) ? tree.then : tree.otherwise;
}
function cmp(a: number, op: Cmp, b: number): boolean {
  switch (op) { case '>': return a>b; case '<': return a<b; case '>=': return a>=b;
    case '<=': return a<=b; case '==': return a===b; case '!=': return a!==b; }
}
```

`IF [Hourly_ACoS > 45%] AND [Current_Inventory_Days < 14] THEN [Reduce_Bid_By 20%] ELSE [Maintain_Pacing]`
parses to `{ when: and([ACoS>0.45, InvDays<14]), then:[Reduce_Bid_By 20], otherwise:[Maintain_Pacing] }`
and, given `{Hourly_ACoS:0.5, Current_Inventory_Days:9}`, evaluates to
`[{verb:'Reduce_Bid_By',arg:20}]`.

### 5.2 Hourly Share-of-Voice tracker

For each high-value term, capture the top-of-search slots and classify each as
**our-organic**, **our-paid**, or **competitor** (by brand/seller match), then
persist SOV in bps onto the stream.

```typescript
export class SovTrackerService {
  constructor(private readonly serp: SerpClient, private readonly pg: Pool) {}

  async captureTerm(term: string, marketplace: string, ourBrands: string[], competitors: string[]) {
    const slots = await this.serp.topOfSearch(term, marketplace, { limit: 20 }); // [{asin,brand,sponsored}]
    const total = slots.length || 1;
    const isOurs = (b: string) => ourBrands.some(x => b.toLowerCase().includes(x.toLowerCase()));
    let ourPaid = 0, ourOrganic = 0; const byCompetitor: Record<string, number> = {};
    for (const s of slots) {
      if (isOurs(s.brand)) (s.sponsored ? ourPaid++ : ourOrganic++);
      else { const c = competitors.find(x => s.brand.toLowerCase().includes(x.toLowerCase()));
             if (c) byCompetitor[c] = (byCompetitor[c] ?? 0) + 1; }
    }
    const bps = (n: number) => Math.round((n / total) * 10000);
    await this.pg.query(
      `INSERT INTO sov_hourly (bucket_ts, term, marketplace, our_paid_bps, our_organic_bps,
                               competitor_bps, detail)
       VALUES (date_trunc('hour', now()), $1,$2,$3,$4,$5,$6)
       ON CONFLICT (bucket_ts, term, marketplace) DO UPDATE
         SET our_paid_bps=$3, our_organic_bps=$4, competitor_bps=$5, detail=$6`,
      [term, marketplace, bps(ourPaid), bps(ourOrganic),
       bps(Object.values(byCompetitor).reduce((a, b) => a + b, 0)), JSON.stringify(byCompetitor)]);
    return { term, ourPaidBps: bps(ourPaid), ourOrganicBps: bps(ourOrganic), byCompetitor };
  }
}
```

### 5.3 SOV → bidding override (reclaim placement)

If a single competitor seizes >15% of top-of-search ad real estate on a primary
term, enqueue an aggressive bid override toward the strategy's max-bid cap.

```typescript
export class SovDefenseService {
  constructor(private readonly sov: SovTrackerService, private readonly bidding: BiddingEngineService,
              private readonly pg: Pool) {}

  async enforce(productId: string, term: string, marketplace: string,
                ourBrands: string[], competitors: string[]) {
    const snap = await this.sov.captureTerm(term, marketplace, ourBrands, competitors);
    const topThief = Object.entries(snap.byCompetitor).sort((a, b) => b[1] - a[1])[0];
    const stolenBps = topThief ? topThief[1] : 0;
    if (stolenBps <= 1500) return { triggered: false, stolenBps };   // 15% threshold

    // resolve the atomic keyword + strategy, then drive an override bid at the cap
    const r = (await this.pg.query(
      `SELECT b.external_id, b.account_ref, s.max_bid_minor, s.min_bid_minor, s.target_acos_bps,
              p.price_minor, p.days_of_supply
         FROM ad_entities_bridge b
         JOIN product_strategies ps ON ps.product_id = b.product_id
         JOIN ad_strategies s ON s.id = ps.strategy_id
         JOIN internal_products p ON p.id = b.product_id
        WHERE b.product_id=$1 AND b.is_atomic AND lower(b.atomic_keyword)=lower($2)
          AND b.entity_kind='AD_GROUP' LIMIT 1`, [productId, term])).rows[0];
    if (!r || !r.max_bid_minor) return { triggered: true, stolenBps, applied: false };

    await this.bidding.optimizeBatch([{
      bridgeId: productId, externalId: r.external_id, accountRef: r.account_ref,
      currentBidMinor: r.min_bid_minor, aov_minor: r.price_minor,
      cr7d: 0.1, cr30d: 0.1, acosTargetBps: r.target_acos_bps ?? 5000,
      acos1hBps: null, daysOfSupply: r.days_of_supply,
      bidMinMinor: r.min_bid_minor,
      bidMaxMinor: r.max_bid_minor,                 // override rides to the cap
    }]);
    return { triggered: true, stolenBps, applied: true, reclaimBidMinor: r.max_bid_minor };
  }
}
```

The defense override deliberately reuses the bidding engine (not a side channel),
so the inventory-elasticity throttle still protects against reclaiming a
placement for a product about to stock out — the cap is the ceiling, not a bypass.

---

## How this maps onto the shipping app

| Blueprint concept | Lives today as |
|---|---|
| `hourly_performance_stream` (Timescale) | `AmazonAdsDailyPerformance` (day grain) + AMS ingest (`ads-marketing-stream.service`) |
| `ad_entities_bridge` | `Campaign`/`AdGroup`/`AdTarget`/`AdProductAd` + `AdProductAdProduct` link |
| `ad_strategies` | `AdBudgetPlan` + per-campaign `dynamicBidding.targetAcos` (goal builder) |
| Bidding engine | `ads-bid-optimizer.service` (target-ACOS) — add inventory θ + intraday θ |
| Atomic fabric | `ads-architect.service` SKAG strategy + `ads-create.service` v3 creates |
| AMC / budget shifter | `OutboundSyncQueue` + budget-pool rebalancer; AMC runner is net-new |
| NL rules engine | `automation-rule.service` conditions DSL + `_shared/ads-ui` rule builder |
| SOV tracker | `ads-impression-share.service` (within-account proxy) — add SERP capture |
| TanStack master grid | `grid-lens` (VirtualizedGrid + PreferencesModal) |

The migration path is additive: introduce TimescaleDB as a parallel hot store
fed by the existing AMS ingest, layer pgvector onto the current `Product` table,
and graduate the bid optimizer to the inventory-aware model above.
