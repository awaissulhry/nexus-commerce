# Turning the switches on — the running record

**Started 2026-09-21** on the Owner's instruction: *"for all those switched off, we need to
convert them and switch them on."*

Six things shipped built-but-off. They are **not** flipped together: two have a probe built
specially for them, because someone already decided flipping blind was too risky, and one of those
is the money path.

## Order, and why

| # | Switch | State | Gate |
|---|---|---|---|
| 1 | `NEXUS_ENABLE_IMAGE_READBACK_SWEEP` | ✅ **ON 2026-09-21 11:58 UTC** | none — it only reads images back |
| 2 | `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN` | ✅ **ON 2026-09-21 11:58 UTC** | none — read/dry-run only, sandbox hosts only |
| 3 | Amazon **Finances** 2024-06-19 | ⏸ waiting on the probe | the envelope is unknown; guess wrong and a settlement day reads as a quiet day |
| 4 | Amazon **Orders** 2026-01-01 | ⏸ waiting on the probe | 🔴 the new model gives **price per unit**, v0 gave the **line total** |
| 5 | `NEXUS_AMAZON_ENV_TOKEN=off` | ⏸ waiting on a log window | needs hours of real Amazon traffic to say anything |
| 6 | `NEXUS_ENABLE_ETSY_PUBLISH` | ⏸ waiting on products | production has **0 Etsy listings** |

## 1–2 — done, and exactly what to expect

**Both were verified read-only before being set, not assumed:**

- The image sweep's job and its service read the **same** switch (`image-readback-sweep.job.ts`
  §"One switch, not two"), so there is no scheduled job that runs and reports "off" forever.
- The contract run refuses anything that is not a read or the channel's own dry run
  (`kind: 'read'` at the gateway) and requires the URL to resolve to a **sandbox host**
  (`sandboxUrlOf`). It cannot touch a live listing by construction.

⚠️ **The contract run will report `not-configured`, and that is correct.** It needs its own
sandbox accounts — `NEXUS_CONTRACT_ACCOUNT_EBAY`, `…_AMAZON_SP`, `…_AMAZON_ADS`, `…_SHOPIFY`,
`…_ETSY` and `NEXUS_CONTRACT_AMAZON_SELLER_ID` — and **none of them is set in production**
(checked against Railway's variable-name list).

It was turned on anyway, deliberately: `not-configured` is **never reported as green**, so the
gap becomes a visible line on the Health tab instead of an absence nobody can see. That is this
programme's own rule — *`no_data` is never a pass* — applied to itself. Setting those accounts is
an Owner step, and until then nightly output is a true "not configured".

## 3–4 — the two probes are the Owner's to run

🔴 **This session cannot run them: both answer HTTP 401.** Measured, with a control:

```
GET  /api/health                              → 200   ← control
GET  /api/admin/amazon-orders-2026-probe      → 401
POST /api/amazon/financials/sync {"probe":true} → 401
```

They need a signed-in session, and Railway redacts variable **values**, so there is no token to
use. Handling one would be the wrong move regardless.

Host note: `api.xavia.it` does not resolve from this session (the control fails too, so that is
*cannot reach*, not *down*). `https://nexusapi-production-b7bb.up.railway.app` does.

**Both probes are reads.** The Orders one is documented as *"a GET… it changes nothing on the
seller account"*; the Finances one *"reads one page, keeps no payload"*, with tests pinning no
`prisma.`, no `.create(`, no pagination loop.

### The commands

Signed in to the app, in the browser console:

```js
// 1 — Orders: what Amazon really sends, with buyer data redacted
await (await fetch('/api/admin/amazon-orders-2026-probe')).json()

// 2 — Finances: which envelope, writing nothing
await (await fetch('/api/amazon/financials/sync', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ probe: true }),
})).json()
```

### What to look for

| probe | the answer that says "safe to flip" |
|---|---|
| Finances | `envelope` is `"bare"` or `"payload"` — **not `null`**. `null` means Amazon sent a shape we do not recognise, and `rootKeys` names what it did send |
| Orders | the mapped result's money matches the real order. 🔴 Specifically: v0's `ItemPrice` is the **line total**, so for a quantity of 2 at 49.99 it must read **99.98**, not 49.99 |

## 5 — the env token needs a window, not a moment

The check is whether `[amazon-sp] STILL USING the environment refresh token` ever appears.
Checked at 11:54 UTC and the answer was **unusable**: the deployment was two minutes old and had
made no Amazon call. The control (`amazon-sp` unfiltered) was empty too — which is what makes it
*could not measure* rather than *clean*.

Give it a day of real traffic, then read it. Never appearing → set `NEXUS_AMAZON_ENV_TOKEN=off`.

## 6 — Etsy waits for products

The Owner is adding them. Until a listing exists, turning Etsy publishing on proves nothing:
`build/P4.6e.md` §3b records **0 Etsy `ChannelListing` rows** in production.
