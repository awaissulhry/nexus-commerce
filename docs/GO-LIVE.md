# Go-Live Runbook — Channel Publishing (Amazon / eBay / Shopify)

> Why this exists: in June 2026 the publish system sat **`gated`** for 30+ days —
> ~10,000 Amazon publish attempts, **0 succeeded** — while the UI showed "Done."
> Nothing reached Amazon. This runbook is how you tell, at any moment, whether a
> publish actually goes out, and how to flip it live safely.

---

## 1. The mental model — every channel has a 2-flag gate

A publish only reaches a channel when its mode is **`live`**. Each channel needs
**both** an enable flag **and** a mode flag set on the **Railway API service**:

| Channel | Enable flag (default `false`) | Mode flag (default `dry-run`) |
|---|---|---|
| Amazon | `NEXUS_ENABLE_AMAZON_PUBLISH=true` | `AMAZON_PUBLISH_MODE=live` |
| eBay | `NEXUS_ENABLE_EBAY_PUBLISH=true` | `EBAY_PUBLISH_MODE=live` |
| Shopify | `NEXUS_ENABLE_SHOPIFY_PUBLISH=true` | `SHOPIFY_PUBLISH_MODE=live` |

Modes: **`gated`** (enable flag off → nothing sent) · **`dry-run`** (validated,
no HTTP) · **`sandbox`** (Amazon/eBay only) · **`live`** (real). Anything that is
not `live` publishes **nothing** — by design, default-safe.

Plus the credentials a live Amazon publish needs (already set on prod):
`AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN`,
`AMAZON_SELLER_ID` (`AMAZON_REGION` / `AMAZON_MARKETPLACE_ID` optional).

---

## 2. Check current state (do this first — and any time)

```bash
# Mode + creds presence + liveReady + pending-queue size, per channel.
curl -s https://<api-host>/api/listings/publish-readiness | jq

# + a READ-ONLY SP-API probe that proves creds actually reach Amazon (no publish):
curl -s "https://<api-host>/api/listings/publish-readiness?probe=1" | jq .probe

# What's queued (so a go-live flip won't fire a flood):
curl -s https://<api-host>/api/listings/publish-readiness | jq .pendingQueue

# Why is the async queue stuck? (per-row syncType / age / hold / retries / error)
curl -s "https://<api-host>/api/listings/publish-readiness?stuck=1" | jq .stuck
```

`liveReady: true` + `probe.amazon.ok: true` means you're genuinely live. The boot
logs also print: `📣 PUBLISH MODES at boot — Amazon=… eBay=… Shopify=…`.

The 30-day audit lives at `GET /api/listings/publish-status` (outcomes by
channel/mode — watch the `gated` vs `success` counts).

---

## 3. Go-live procedure

1. **Check the pending queue** (`?` above). A large `pendingQueue.total` will all
   fire the moment you go live — make sure that's intended.
2. **Set the two flags** for the channel on the Railway API service, **redeploy**.
3. **Verify**: `?probe=1` shows `liveReady:true` + `probe.ok:true`; the boot
   banner shows `Amazon=live`.
4. **Confirm a real write**: publish one listing (flat-file "Submit to Amazon" or
   the cockpit). The badge next to the button must read **`AMAZON LIVE`** (green),
   you get a **real** feedId (not `dryrun-*`), it appears in publish history, and
   shows up in Seller Central → Inventory → Upload status.

To go back to safe: set the enable flag to `false` (→ `gated`, nothing publishes).

---

## 4. The honest-UI guarantees (so "Done" can't lie again)

- A **`PublishModeBadge`** sits at every publish action (flat-file, Amazon cockpit,
  eBay cockpit) showing `LIVE` / `DRY-RUN` / `SANDBOX` / `GATED·OFF`.
- A dry-run/gated submit shows an **amber "validated, NOT published"** toast/banner
  — never a green "Submitted/Done".
- The async cascade marks a dry-run row **`SKIPPED`**, not green `SUCCESS`.

---

## 5. Troubleshooting

**"It said Done but nothing reached the channel / price unchanged."**
→ You're not `live`. Check `publish-readiness`. A `dryrun-*` feedId = dry-run.

**"The async queue isn't draining" (master-price / stock cascade not publishing).**
→ Check `GET /api/outbound/worker-status`. If `isProcessing:true` with a stale
`lastProcessingTime`, a cycle wedged. The worker now self-heals: a 3s Redis-getJob
timeout, a 45s per-dispatch ceiling (`NEXUS_SYNC_DISPATCH_TIMEOUT_MS`), and a
5-min stale-lock watchdog (`NEXUS_SYNC_STALE_LOCK_MS`) force-reset a stuck cycle.
Use `?stuck=1` to see the parked rows. A redeploy clears an in-memory wedge.
(Root cause of the original incident: an unreachable-Redis `getJob()` that *hung*
rather than erroring — see `scripts/clear-pending-syncs.mjs` for the one-shot used
to drain a stale backlog.)

**"Shopify published something I didn't expect."**
→ Shopify now requires `NEXUS_ENABLE_SHOPIFY_PUBLISH=true` + `SHOPIFY_PUBLISH_MODE=live`
(previously it went live the instant creds existed). Off by default.

---

## 6. Worker / queue env knobs

| Var | Default | Effect |
|---|---|---|
| `NEXUS_SYNC_DISPATCH_TIMEOUT_MS` | `45000` | Per-row publish ceiling in the backstop cron |
| `NEXUS_SYNC_STALE_LOCK_MS` | `300000` | Force-reset the worker lock after this long |
| `ENABLE_QUEUE_WORKERS` | unset | BullMQ workers (needs `REDIS_URL`/`REDIS_HOST`); the every-minute cron is the always-on backstop regardless |
