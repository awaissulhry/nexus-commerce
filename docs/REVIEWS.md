# Reviews — Operator Manual

**The `/marketing/reviews` workspace** (one tab bar — `ReviewsNav`):
- **Feed** `/marketing/reviews` — review feed + KPIs + star ratings + ingest health + spikes
- **Desk** `/marketing/reviews/desk` — triage + AI-drafted replies (RX.2)
- **Spotlight** `/marketing/reviews/spotlight` — AI Voice-of-Customer brief (RX.4)
- **Heatmap / By Product** — day×category + per-product analytics (SR.2)
- **Spikes** `/marketing/reviews/spikes` — quality-anomaly alerts + "Generate fixes"
- **Actions** `/marketing/reviews/actions` — closed-loop spike fixes (RX.5)
- **Automation** — review-domain AutomationRules (SR.3)
- **Requests** `/marketing/reviews/requests` — post-purchase request pipeline dashboard
- **Import** `/marketing/reviews/import` — bring in real reviews (CSV/JSON/XLSX) (RX.1)
- **Rules** `/orders/reviews/rules` — review-request rules CRUD (mounted in the same nav)

Per-order: "Request review" button on `/orders/[id]`; per-order history at `/orders?lens=reviews`.

This guide covers the post-purchase review pipeline (RV-series, §1–11) plus the
RX-series rebuild that took `/marketing/reviews` to best-in-class:
RX.0 ratings + nav, RX.1 ingestion/import (§12), RX.2 Response Desk (§13),
RX.3 real-time/alerts/digest (§14), RX.4 Spotlight (§15), RX.5 action loop (§16),
RX.6 request enhancements (§17).

---

## 1. Quick start

1. Open `/orders/reviews/rules`.
2. Click **New rule** (or pick a preset: "Amazon — safe default", "aggressive 5d", "FBA only — careful").
3. Choose **Scope** (recommended for Xavia: AMAZON_PER_MARKETPLACE = IT).
4. Tick **Use negative-feedback diversion** if you want the "How was it?" funnel (recommended — see §6).
5. Save.

The cron (every 4h) will start scheduling matching orders automatically. To trigger immediately: open `/marketing/reviews/requests` → **Run mailer now**.

---

## 2. The pipeline

```
Order delivered
    ↓
schedulePendingOrders (4h cron)
    ↓
Match best ReviewRule by scope priority:
  AMAZON_PER_MARKETPLACE > AMAZON_GLOBAL > EBAY/SHOPIFY > MANUAL
    ↓
Create ReviewRequest (status=SCHEDULED, scheduledFor=deliveredAt + rule.minDays)
+ optional ReviewSentimentCheck (if rule has diversion enabled)
    ↓
runReviewMailerOnce (4h cron tick)
    ↓
Branch on linked sentimentCheck:
  ├── no diversion → fire Amazon Solicitations OR send eBay/Shopify email
  ├── NONE (not yet sent) → send "How was it?" email, defer +5d
  ├── NONE (5d elapsed) → fallback: fire Solicitations
  ├── POSITIVE → fire Solicitations now
  └── NEGATIVE → SKIPPED (already routed to support inbox)
    ↓
Result: status=SENT | FAILED | SKIPPED
```

---

## 3. ReviewRequest status table

| Status     | Meaning |
|------------|---------|
| ELIGIBLE   | Default initial state (rarely seen in practice). |
| SCHEDULED  | Waiting for `scheduledFor`. The cron will pick it up. |
| SENT       | Amazon Solicitations API returned 2xx (or non-Amazon email sent). |
| FAILED     | Send failed transiently. Will be retried up to 3 times with 4h/8h/16h backoff. |
| SUPPRESSED | Eligibility check failed (active return, refund, outside window). |
| SKIPPED    | Permanent no-send (already solicited, diverted negative, env dry-run). |

**Common `providerResponseCode` values:**

| Code | Meaning |
|------|---------|
| `OK` | 2xx from Amazon. |
| `NOT_IMPLEMENTED` | `NEXUS_ENABLE_AMAZON_SOLICITATIONS` env flag is off (dry-run). |
| `ALREADY_SOLICITED` | Amazon's HTTP 400/403 + "already" — Amazon enforces 1 solicitation per order. Benign. |
| `UNKNOWN_MARKETPLACE` | Order's marketplace short code didn't map to an Amazon marketplaceId. |
| `DIVERTED_NEGATIVE` | Customer clicked 😕 on the "How was it?" email; routed to support. |
| `HTTP_5xx` | Transient server error. Retried automatically. |
| `EXCEPTION` | Network / TLS / parsing error. Retried automatically. |

---

## 4. Pipeline source authority for `deliveredAt`

The whole pipeline schedules off `Order.deliveredAt`. Multiple writers can set it; higher-authority sources win:

| Source             | Set by | Authority |
|--------------------|--------|-----------|
| `AMAZON_API`       | `OrderStatus='Delivered'` from SP-API GetOrders | Highest |
| `AMAZON_REPORT`    | RV.7 nightly orders-delivered backfill | High |
| `CARRIER_WEBHOOK`  | Sendcloud / carrier delivery confirmation | High |
| `MCF_API`          | Multi-Channel Fulfillment shipment status | High |
| `MANUAL`           | Operator override via `/orders/[id]` "Mark delivered" | Authoritative |
| `HEURISTIC_FBA_3D` | Inline fallback: shippedAt + 3 business days | Low |

The RV.7 cron progressively upgrades `HEURISTIC_FBA_3D` rows to `AMAZON_REPORT` as Amazon confirms deliveries.

---

## 5. Common ops tasks

### Create a rule
`/orders/reviews/rules` → **New rule** → pick scope + marketplace + timing.

### Pause all automated sending
`/marketing/reviews/requests` → **Pause mailer** → optional reason. Cron still ticks but skips all sends.

### Re-queue a SUPPRESSED / FAILED / SKIPPED row
On the dashboard's Upcoming queue, click **Re-queue** (rotation icon) on the row. Status reverts to SCHEDULED + scheduledFor = now + attemptCount = 0.

### Snooze a row
Click one of `4h / 1d / 3d / 1w` on the row. Pushes `scheduledFor` forward.

### Manually mark an order delivered
`/orders/[id]` → green **Mark delivered** button (appears on SHIPPED orders without `deliveredAt`). Source = MANUAL.

### Manually request a review for one order
`/orders/[id]` → amber **Request review** button. Fires Solicitations immediately if eligible.

### Bulk request for many orders
Multi-select on `/orders` → **Request reviews** in the bulk action bar. After completion, a drill-down modal lists which orders succeeded / skipped / failed with reasons.

### See conversion rate
`/marketing/reviews/requests` → "Conversion analytics" section (RV.8). Shows last-30-day sent → reviews-left attribution rate, per-marketplace + per-product-type breakdowns, and a daily sparkline.

---

## 6. Negative-feedback diversion (review funnel)

The headline rating-lift feature. When a rule has **Use negative-feedback diversion** enabled, instead of firing the Amazon Solicitations API immediately, the pipeline:

1. At `deliveredAt + minDays`, sends a branded bilingual "How was it?" email with two buttons:
   - 😊 **Adoro** / **I love it** → opens `/r/[token]/positive`, records POSITIVE, then fires the normal Solicitations call.
   - 😕 **Qualcosa non va** / **Something's wrong** → opens `/r/[token]/negative` with a feedback form, records NEGATIVE, emails the support inbox.
2. If the customer doesn't click within 5 days, falls back to direct Solicitations (no diversion).

Unhappy customers get routed to support **before** they leave a public 1-star review. Industry-standard rating-lift technique used by major sellers — expected +0.2 to +0.5 star average rating effect.

The **Sentiment funnel** tile on the dashboard shows pending / positive / negative counts.

---

## 7. Environment variables

| Variable | Required for | If missing |
|---|---|---|
| `NEXUS_ENABLE_REVIEW_INGEST=1` | All review crons (mailer + delivered-backfill + rule-evaluator) | Crons never start. |
| `NEXUS_ENABLE_AMAZON_SOLICITATIONS=true` | Real Amazon Solicitations API calls | Dry-run only (SKIPPED with NOT_IMPLEMENTED). |
| `NEXUS_ENABLE_OUTBOUND_EMAILS=true` | All emails (sentiment, eBay/Shopify, support) | Dry-run logs only. |
| `RESEND_API_KEY=re_…` | Email transport | Email sends fail. |
| `NEXUS_REVIEW_MAILER_SCHEDULE` (optional) | Override the default `0 */4 * * *` | Defaults to every 4h. |
| `NEXUS_ORDERS_DELIVERED_BACKFILL_SCHEDULE` (optional) | Override the default `30 3 * * *` | Defaults to 03:30 UTC daily. |
| `NEXUS_SUPPORT_INBOX=support@xavia.it` | Where negative-feedback diversion emails route | Defaults to `support@xavia.it`. |
| `NEXUS_WEB_URL` (optional) | Base URL for `/r/[token]/*` landing pages | Defaults to `https://nexus-commerce-three.vercel.app`. |
| `SHOPIFY_REVIEW_DOMAIN` (optional) | Shopify review landing | Field blank in email. |

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard shows 0 scheduled despite many delivered orders | `Order.deliveredAt` not set on those orders | Wait for RV.7 cron (03:30 UTC daily). Or manually trigger via `/api/sync-logs/cron/orders-delivered-backfill/trigger`. Or use per-order "Mark delivered" button. |
| All Solicitations land as SKIPPED with NOT_IMPLEMENTED | `NEXUS_ENABLE_AMAZON_SOLICITATIONS` is not set or `!= "true"` in Railway env. | Set it to `true` and redeploy. |
| Many FAILED rows showing HTTP 403 | These are Amazon's "already solicited" duplicate-protection — should auto-classify as SKIPPED. If not, the classifier regex isn't matching. | Check the row's `errorMessage` content — should contain "already". |
| Sentiment emails not sending | `NEXUS_ENABLE_OUTBOUND_EMAILS=true` not set, OR `RESEND_API_KEY` missing. | Set both. |
| `/r/[token]/positive` shows "Couldn't record" | The token doesn't exist (typo, expired, or never created), or the API is down. | Check `Order` link from the dashboard; verify the token in the DB. |
| Conversion rate analytics shows 0% | No `Review` rows ingested yet — review-ingest cron may not be enabled or may have nothing to ingest. | Check that `review-ingest` cron has run; verify some Amazon orders have ASINs that match products in your catalog. |

---

## 9. Audit history

| Phase | Commit | Date | What |
|---|---|---|---|
| RV.1 | — (audit only) | 2026-05-23 | Discovered: 0 review rules, 0 ReviewRequest rows ever, 0 orders with `deliveredAt` set, cron never ran (env flag missing). |
| RV.2 | `dd87db9d` + 3 follow-ups | 2026-05-23 | `Order.deliveredAtSource` enum, FBA shippedAt+3bd heuristic, manual override, backfill endpoint, HTTP 403 dup-protect classifier. 44 real Solicitations sent. |
| RV.3 | `cc4c4a24` | 2026-05-23 | Rule-aware scheduler (tags ruleId), app-level retry w/ 4h/8h/16h backoff, DRY consolidated Solicitations service. |
| RV.4 | `c9a7d86c` | 2026-05-23 | Operator UX: pause/resume toggle, per-row unsuppress + snooze, bulk drill-down modal, retrying KPI. |
| RV.6 | `ab415d4e` | 2026-05-23 | Negative-feedback diversion: ReviewSentimentCheck model, `/r/[token]/positive` + `/negative` public pages, bilingual "How was it?" email, mailer state machine, sentiment funnel UI. |
| RV.7 | `a2f84aaa` | 2026-05-23 | Real Amazon-report-driven `deliveredAt` via `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL`. Daily 03:30 UTC cron. |
| RV.8 | `6cdef63a` | 2026-05-23 | Conversion-rate analytics + per-marketplace + per-productType breakdowns + 30d sparkline + operator manual. |
| RV.9 | (this commit) | 2026-05-23 | Operational polish: first-run nudge (RV.9.1), stuck-cron sweeper + pipeline health banner (RV.9.2), DE/FR/ES email localization (RV.9.3), per-rule conversion analytics (RV.9.4), GDPR/CAN-SPAM EmailSuppression + unsubscribe (RV.9.5), end-to-end test mode (RV.9.6), Review → ReviewRequest/Rule attribution persistence (RV.9.7). |

---

## 10. What's not yet supported

- Webhook for "review left" → automated thank-you email to repeat-customer programs.

(Per-rule fallback, A/B testing, ToS linting, and rule export/import shipped
in RX.6 — see §17.)

Ask in `#orders-eng` if you need any of these prioritized.

---

## 12. RX.1 — Getting real reviews in (import + live adapters)

The SR ingest pipeline classifies whatever reviews land in the `Review`
table. Out of the box those are **sandbox fixtures**. RX.1 adds real
data, all funnelling through the same dedup → sentiment → category-rate
core (`ingestRawReviews`), and stamps each row's `ingestSource`.

**Provenance.** Every `Review` now carries `ingestSource`:
`FIXTURE` | `IMPORT_CSV` | `EBAY_API` | `AMAZON_VOC` | `SHOPIFY_WEBHOOK` |
`MANUAL`. The dashboard **Ingestion health** strip shows, per channel,
real-vs-fixture counts + last-ingest time, and a mode chip
(`sandbox`/`live`).

### Import (works today, all channels)
`/marketing/reviews/import` → pick channel + (optional) marketplace →
paste or upload CSV / JSON / XLSX → **Preview**. Columns auto-map (fix
any in the mapping editor); the preview shows valid / invalid /
duplicate / will-import counts + a sample. **Import** ingests only new,
valid rows (idempotent — re-importing the same export is safe).
Where to export from: Amazon Seller Central → Brand → Customer Reviews /
Voice of the Customer; eBay feedback export; Judge.me / Loox / Yotpo.

API: `POST /api/reviews/import/preview` + `/apply`
(`{text|bytesBase64, fileKind, channel, marketplace?, columnMapping?}`).

### Live adapters (opt-in; read-only; error-isolated)
Active only when `NEXUS_REVIEW_INGEST_MODE=live`. Each adapter is gated
on its own credentials and never throws past its boundary — a channel
outage is recorded as a note/error and the others still ingest.

- **eBay** (`fetchEbayFeedback`) — Trading API `GetFeedback`
  (FeedbackReceivedAsSeller). Maps Positive/Neutral/Negative → 5/3/1★.
  Runs when `NEXUS_EBAY_REAL_API=true` **and** an active eBay
  `ChannelConnection` exists. No write to eBay.
- **Amazon** (`fetchAmazonVocFeed`) — Amazon exposes no official
  review-text API, so the live path reads a **licensed third-party feed**
  (Helium10 / Jungle Scout / DataHawk) via `NEXUS_AMAZON_REVIEW_FEED_URL`
  (+ optional `NEXUS_AMAZON_REVIEW_FEED_TOKEN`). Unset → no-op; use import.

| Env var | Effect | Default |
|---|---|---|
| `NEXUS_REVIEW_INGEST_MODE` | `live` enables the channel adapters; anything else = sandbox fixtures. | sandbox |
| `NEXUS_EBAY_REAL_API` | Gate for the live eBay GetFeedback call (same flag as the write-path). | unset (off) |
| `NEXUS_AMAZON_REVIEW_FEED_URL` | JSON review feed for live Amazon ingest. | unset (import only) |
| `NEXUS_AMAZON_REVIEW_FEED_TOKEN` | Bearer token for that feed, if needed. | unset |

---

## 13. RX.2 — Response Desk (triage + AI replies)

`/marketing/reviews/desk` is a workqueue over every review.

**Triage.** Each review has `triageStatus` (NEW → IN_PROGRESS → RESPONDED
/ RESOLVED / IGNORED; null = NEW), an `assignee`, free `triageTags`, and
an internal `triageNote`. Status tabs at the top show live counts; the
channel filter narrows the queue. `PATCH /api/reviews/:id/triage`.

**AI replies.** "Draft with AI" calls `POST /api/reviews/:id/reply/draft`
→ `draftReviewReply()`: localized per the review's marketplace (IT/DE/FR/
ES/EN, override in the UI), tone auto-selected from sentiment
(apologetic / appreciative / neutral), on-brand via the Brand Brain voice
block. Policy guardrails are in the system prompt (no incentives, never
ask to change/remove the review, no links). Falls back to a localized
template when `ANTHROPIC_API_KEY` is absent, so a draft always appears.
Model override: `NEXUS_REVIEW_REPLY_MODEL` (default Haiku 4.5).

**Sending.** `POST /api/reviews/:id/reply/send`:
- **eBay** → real Trading API `RespondToFeedback` (gated by
  `NEXUS_EBAY_REAL_API` + active connection). On success the review flips
  to RESPONDED.
- **Amazon / Shopify** → no public reply API exists, so the operator
  posts on-platform and the desk records it as a `MANUAL` response and
  marks RESPONDED.

Every draft/send is logged as a `ReviewResponse` row (DRAFT / SENT /
FAILED) for an auditable reply history.

---

## 14. RX.3 — Real-time + alerts

**Live bus.** `review-events.service.ts` is an in-process event bus
(mirrors order-events) with a 100-event/5-min replay buffer. Events:
`review.created`, `review.negative`, `review.spike.detected`,
`review.responded`. Published from the ingest service (new rows),
spike detector, and reply-send. Clients connect to
`GET /api/reviews/events?since=<ts>`.

**Auto-refresh.** The Feed and Response Desk subscribe via
`useReviewEventsRefresh` and re-fetch (debounced) as reviews land / are
answered. A pulsing **Live** chip sits on both headers.

**Alerts.** `ReviewLiveChip` raises a toast + (opt-in) browser
notification on `review.negative` and `review.spike.detected`, with
quick links into the Desk / spikes. Two new notification classes —
`reviewNegative` (on by default) and `reviewSpike` — appear on
`/settings/notifications`.

**Daily digest.** `review-digest` cron (default 08:00 UTC, or
`POST /api/reviews/cron/digest/trigger`) emails an operator summary:
new reviews by sentiment, average rating, top complaint categories,
negatives awaiting a reply, open Desk items, open spikes. Skips quiet
days. Gated by `NEXUS_ENABLE_REVIEW_DIGEST=1`; recipients via
`NEXUS_REVIEW_DIGEST_TO` (falls back to `NEXUS_SUPPORT_INBOX`).

---

## 15. RX.4 — AI Review Spotlight

`/marketing/reviews/spotlight` is an AI Voice-of-Customer brief over a
window of reviews: sentiment mix, top complaint + praise themes (with
verbatim quotes), emerging issues, and concrete recommended actions
(fix the size chart, QA a component, reframe value…). Each
recommendation is tagged by area (listing / content / product / ops).

Briefs are **persisted** (`ReviewSpotlight` table) rather than recomputed
per page-load, to stay efficient with AI tokens — the page reads the
latest cached brief and offers a **Regenerate** button (7 / 30 / 90-day
window). `productId = null` is a global brief.

- `GET /api/reviews/spotlight?productId=&marketplace=` — latest cached
- `POST /api/reviews/spotlight/generate` — regenerate

Synthesis uses Anthropic (model override `NEXUS_REVIEW_SPOTLIGHT_MODEL`,
default Haiku 4.5) and falls back to a deterministic heuristic brief
(built from sentiment categories + top phrases) when no AI key is set,
so a useful brief is always produced.

---

## 16. RX.5 — Closed action loop (Actions tab)

SR.3 already drafts spike-driven fixes (improved bullets, an A+ module)
via the AutomationRule engine, but the output only lived in execution
logs. RX.5 makes those fixes **actionable**.

On the **Spikes** tab, "Generate fixes" runs the drafters for a spike and
persists `ReviewActionItem` rows (dedup: one OPEN item per spike+type):
- **BULLETS** — 5 AI-drafted listing bullets addressing the complaint.
- **APLUS** — a short A+ content module.
- **RECALL_FLAG** — only for SAFETY-category spikes (helmets / protective
  gear): a GPSR recall-assessment flag linking to
  `/fulfillment/stock/recalls`.

The **Actions** tab (`/marketing/reviews/actions`) is the workqueue:
Open / Applied / Dismissed, with the drafted content inline, a Copy
button, and Apply / Dismiss. Endpoints:
`POST /api/reviews/spikes/:id/generate-actions`,
`GET /api/reviews/action-items`, `PATCH /api/reviews/action-items/:id`.
Heuristic fallbacks apply when no AI key is set.

---

## 11. RV.9 — Operational polish notes

**Setup nudge (RV.9.1).** If `/orders/reviews/rules` shows no active Xavia-IT rule (the most common first-run mistake), an amber banner offers a one-click "Set up Xavia IT default" — creates a rule with the 7–25d window, returns/refunds exclusions, sentiment diversion on. Same banner repairs misconfigured rules (scope=AMAZON_PER_MARKETPLACE but marketplace=null).

**Pipeline health (RV.9.2).** `/marketing/reviews/requests` shows a green "healthy" chip when crons are running, or a rose banner when:
  - Mailer hasn't successfully run in >8h (cron stuck / env unset)
  - One or more watched crons stuck in `RUNNING` >2h (process crash mid-tick)
  - Any watched cron's most recent attempt failed

The orphan-sweeper cron (always-on, every 30 min) auto-marks stuck RUNNING rows as FAILED. Operators can also poke "Sweep stale" on the banner.

**Email localization (RV.9.3).** "How was it?" emails now match the Amazon marketplace's primary language: IT/DE/FR/ES native + English secondary. IT/DE/AT/FR/BE/ES/UK/IE all covered. Unknown markets fall back to Italian. Resolved at send time via `resolveLocaleForMarketplace(order.marketplace)`.

**Per-rule analytics (RV.9.4).** New "By rule" table on the dashboard analytics section. Compare conversion rates across active rules so winners can be kept and laggards retired. Requests created before RV.3 (no ruleId) show as "fallback" — exclude them from rule-vs-rule comparisons.

**GDPR/CAN-SPAM (RV.9.5).** Every outbound email (sentiment + reviewer outreach) checks `EmailSuppression` before sending. Suppressed sends record SKIPPED with `providerResponseCode=SUPPRESSED`, never retry. RFC 8058 List-Unsubscribe + List-Unsubscribe-Post headers unlock the Gmail/Apple Mail one-click button. Customer-facing landing at `/unsubscribed` confirms in their locale. Admin API: `GET/POST/DELETE /api/email/suppressions`.

**Test mode (RV.9.6).** Dashboard "Test mode" panel:
  - **Preview HTML** — iframe rendering of the localized email; flip locales without sending.
  - **Send test email** — real Resend send to an operator-controlled address; `__test__` token short-circuits all DB writes on landing pages.
  - **Dry tick** — counts what a real mailer tick would process right now, surfaces env-flag and pause-state.

**Review attribution persistence (RV.9.7).** The analytics view already joined reviews to sent requests in-memory. RV.9.7 promotes the same heuristic to a 6h cron that writes `Review.attributedRequestId` + `Review.attributedRuleId` back to disk. Idempotent — only fills nulls. Exposes the attribution to downstream consumers (exports, ML, future per-rule revenue calcs) without re-computing.

| Env var | Effect | Default |
|---|---|---|
| `NEXUS_UNSUBSCRIBE_SECRET` | Salts unsubscribe tokens so they aren't trivial-guess. Used for both sentiment + reviewer emails. | `xavia-default-secret` — change in prod. |
| `NEXUS_CRON_ORPHAN_SWEEPER_SCHEDULE` | Cron for stale-RUNNING sweeper. | `*/30 * * * *` |
| `NEXUS_REVIEW_ATTRIBUTION_SCHEDULE` | Cron for review→rule attribution. | `0 */6 * * *` |


---

## 17. RX.6 — Request-pipeline enhancements

Closes the long-standing `/orders/reviews/rules` gaps:

- **Per-rule no-response fallback** (`fallbackOnNoResponse`, default true) —
  when a diversion "How was it?" email gets no reply in 5 days: on = fall
  back to a direct Solicitation (prior behavior); off = skip entirely
  (never solicit a silent customer). Toggle appears under the diversion
  block when diversion is on. Mailer records `NO_RESPONSE_NO_FALLBACK`.
- **A/B variants** — "A/B" on each rule clones it (inactive, name
  suffixed) so you can tweak the timing window and compare via the
  existing per-rule conversion analytics (§ dashboard).
  `POST /api/review-rules/:id/duplicate`.
- **Export / Import JSON** — header buttons. Export downloads all rules
  (portable, id-free); import upserts on (name, scope, marketplace).
  `GET /api/review-rules/export`, `POST /api/review-rules/import`.
- **ToS-compliance linter** — the notes field is checked live for
  incentive language, asking for positive/5-star reviews, external links,
  and review-removal requests (Amazon/eBay policy). Warnings only, never
  blocks. `POST /api/review-rules/lint`.
