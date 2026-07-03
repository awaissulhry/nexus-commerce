# eBay Ads — Operations Runbook

One console: **/marketing/ads → [eBay] switch in the rail**. Everything below assumes eBay mode. All times Europe/Rome unless noted.

## How the data flows (and how fresh it is)

| What | Cadence | Cron (manual trigger via /sync-logs) |
|---|---|---|
| Campaigns / ads / keywords / negatives mirror | hourly :10 | `ebay-ads-entity-sync` |
| Live-listing discovery (+ ended/relist detection, product matching) | every 4h :25 | `ebay-listing-discovery` |
| Performance report tasks (trailing 72h re-pull; sales/fees provisional in that window) | daily ~04:40 | `ebay-ads-report-schedule` |
| Report poll → download → ingest | every 3 min | `ebay-ads-report-poll` |
| Break-even economics rebuild | daily ~07:15 | `ebay-ads-economics-rebuild` |
| Rule evaluation (proposals/autopilot) | daily ~07:45 | `ebay-ads-automation-evaluate` |
| Anomaly + ceiling guard | hourly :50 | `ebay-ads-anomaly-guard` |
| Weekly digest | Monday ~06:30 | `ebay-ads-digest` |

Every page footer/control row shows "Data as of …". Gate/kill env: `NEXUS_ENABLE_EBAY_ADS_SYNC=0` stops all eBay-ads crons; `NEXUS_MARKETING_WRITES_EBAY` (currently **1 = live**) gates every write — unset it to drop the whole console back to sandbox (writes validate + audit locally, nothing reaches eBay).

## The weekly routine (the only required involvement)

Monday: open **Weekly Digest** → read totals vs prior week, movers, anomalies → open the approval queue link → bulk approve/reject proposals → "Mark week reviewed". That's it.

## Turning on break-evens (the one missing input)

Break-even columns show "add cost" because no product costs exist anywhere yet. Enter costs either way:
- `Product.costPrice` (product edit page), or
- receive stock through POs with unit costs → WAC (`weightedAvgCostCents`) fills itself.
Next economics rebuild (or trigger `ebay-ads-economics-rebuild`) lights up break-evens, net margins, and gives rate guardrails + the "Rate above break-even — repair" rule real teeth.

## Automation

- **Dial** (Automation page): Off → Suggest (proposals only) → Auto (rules in AUTOPILOT apply within guardrails). Ships Off. Recommended path: install starter pack → enable rules → Suggest for 2 weeks → Auto for trusted rules.
- **Guardrails you can't turn off**: automations never exceed break-even; no-cost listings are manual-only; monthly ceiling (€300 preset for IT — edit on the page) auto-halts on breach; ⛔ Halt everything stops all writes instantly.
- **Rollback**: Automation page → Recently applied → rollback (applies the recorded inverse, audited).
- **Add a rule**: currently via starter pack or API `POST /api/ebay-ads/automation/rules` `{name, trigger:{scope:'CPS_AD'|'CPC_KEYWORD', all:[{metric, windowDays, op, threshold}]}, action:{type,…}}` — arrives disabled + PROPOSE.

## Alert types → responses

| Alert | Meaning | Do |
|---|---|---|
| `fee spike` | yesterday's fees >3× trailing avg | Check the dashboard trend + campaigns grid sorted by fees; consider pausing the spiking campaign; remember any-click: rate raises act on already-clicked items |
| `ctr collapse` | CTR <40% of trailing on real volume | Listing quality/price changed? Check the listing, consider rate/pause |
| `campaign ended externally` | Status flipped outside Nexus | Someone used Seller Hub or **eBay's mobile "easy boost" (never use it — it overwrites managed rates silently)**; re-create/clone if unintended |
| `spend at N% of ceiling` | 80%+ of the monthly cap | Raise the ceiling deliberately or let the auto-halt protect you at 100% |
| Automation HALTED banner | ceiling breach or operator halt | Fix cause → "resume" on the Automation page |

## Facts that save future debugging (learned live)

- One listing = **one active General campaign** — promoting elsewhere returns "ad already exists" per item (surfaced in results).
- Selection rules are **immutable** → Clone is the edit path. Rates are NOT immutable (`updateAdRateStrategy` / per-ad).
- Priority doesn't exist on **eBay Spain**; SMART can't become MANUAL later; budgets: 15 edits/day/campaign (metered in UI); CPC paces monthly (a day can spend 2× daily).
- Report quirks the pipeline already handles: 7-day task cap, listing/campaign reports rejecting the `day` dimension (single-day tasks), `EUR 1.234,56` money cells, `http://` reportHrefs, header-only reports from paused campaigns (real zeros).
- Re-run a report: delete the zero-row/failed task row (scheduler recreates) or flip INGESTED→SUCCESS (re-download in place).
- Size mandate: moto categories verified **out of scope** (Taglia still FREE_TEXT post-June); revisit only if eBay expands enforcement.
- Scripts: `scripts/_e2-verify.mjs` (data health), probes `_e0-ebay-probe*.mjs` (scope/eligibility/census).
