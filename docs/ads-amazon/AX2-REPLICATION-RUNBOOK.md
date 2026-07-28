# Replicating a campaign structure onto a new product — operator runbook

> For `/marketing/ads/campaigns`. Written 2026-07-28 against the live account.
> There is **no UI for blueprints yet**, so every step is a `fetch` you paste into the browser console.

---

## Before you start — three things that are true of your account

**1. Production writes are LIVE.** `NEXUS_MARKETING_WRITES_EBAY` is eBay; for Amazon the gate is open and IT/DE
have written as recently as this morning. **A non-dry-run apply creates real campaigns that start spending.**

**2. Only AIREON uses the naming convention blueprints understand.** Of 115 active IT campaigns:

| Convention | Count | Example |
|---|---|---|
| `IT-TOKEN-SP-Role` | **11** | `IT-AIREON-SP-Auto` |
| `TOKEN \| IT \| Match \| Type` | 11 | `GALE \| IT \| Auto` |
| everything else | 93 | `AIR MESH BROAD` |

Blueprints derive a campaign's *role* from its name. **Extract from AIREON** — it is the only clean template.
Replicated campaigns are created in the AIREON convention, which is what you want going forward, but they will
look different from the 93 legacy ones. The **diff** feature only produces meaningful output when comparing
against campaigns that share the convention — diffing against `GALE | IT | Auto` will return noise.

**3. The gate will refuse your first attempt, and that is correct.** AIREON and GALE already overlap on 43
keywords. See step 4.

---

## Step 0 — Open a console with a session

1. Log in to the app: **https://nexus-commerce-three.vercel.app/marketing/ads/campaigns**
2. Open DevTools → Console.
3. Paste this helper once. Every later step uses it.

```js
const API = 'https://nexusapi-production-b7bb.up.railway.app'
async function ads(path, body, method) {
  const r = await fetch(API + '/api/advertising' + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',                    // ← your session; without this you get 401
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  console.log(r.status, j)
  return j
}
```

If you get `401 {"error":"Access denied"}`, your session expired — reload the app and retry.

---

## Step 1 — Preview the blueprint (reads only, saves nothing)

```js
await ads('/blueprints/preview', {
  namePrefix: 'IT-AIREON-SP-',
  productToken: 'AIREON',
  marketplace: 'IT',
})
```

**Expect:** `doc.stats` ≈ `{campaigns: 11, adGroups: 11, positives: 137, negatives: 204, productAds: 63}`
and 11 roles: `Auto, Brand-Broad, Brand-Exact, Brand-Phrase, Category-Broad, Category-Exact, Category-Phrase,
Competitor-Broad, Competitor-Exact, Competitor-Phrase, PAT`.

**Check before continuing:**
- `campaigns[].namePattern` shows `IT-{{product}}-SP-…` — the product is parameterised out.
- `sharedTargets` has ~43 entries. **This is the list that will cause conflicts.** Read it now.
- No ASIN appears anywhere in the doc (they are per-product by design).

---

## Step 2 — Save it

```js
const bp = await ads('/blueprints', {
  name: 'SP Jacket Standard (from AIREON)',
  description: '11-campaign SP structure: Auto, Brand/Competitor/Category × Broad/Phrase/Exact, PAT',
  namePrefix: 'IT-AIREON-SP-',
  productToken: 'AIREON',
  marketplace: 'IT',
})
// keep this id
const BP = bp.id
```

`409` means the name is taken — pick another. List them any time with `await ads('/blueprints')`.

---

## Step 3 — Dry run against your target product

`dryRun` defaults to **true**, so this creates nothing. Supply the ASINs you want advertised.

```js
await ads(`/blueprints/${BP}/apply`, {
  productToken: 'VENTRA',              // becomes the {{product}} in every name and brand keyword
  asins: ['B0XXXXXXX1', 'B0XXXXXXX2'], // the ASINs for THAT product
  marketplace: 'IT',
  dailyBudgetCapEur: 120,              // refuse if the structure commits more than this per day
})
```

**Read the response in this order:**

| Field | What it tells you |
|---|---|
| `plan.allowed` | `false` on the first run — expected, see step 4 |
| `plan.totals.dailyBudgetTotal` | **€110/day** for the full AIREON structure. This is a real commitment |
| `plan.totals` | campaigns / positives / negatives / productAds that would be created |
| `plan.conflicts` | keywords that would compete with campaigns you already run |
| `plan.warnings` | e.g. "first write ever to reach FR" |
| `plan.blockers` | why it refused |
| `skippedNonKeyword` | PAT/product targets this phase cannot create — see Limits |

---

## Step 4 — Resolve the conflicts (the important step)

The gate refuses because some of AIREON's keywords are **not about AIREON** — category terms like
`giacca moto` and competitor terms like `dainese`. Creating them for a second jacket puts two of your own
products in the same Amazon auction: you bid against yourself, raise your own clearing price, and split one
pool of demand.

Each conflict names the campaigns you would fight:

```
"giacca moto"  already run by  GALE | IT | Broad | Category,  IT-AIREON-SP-Category-Broad
```

You have two choices per keyword.

**A. Skip it (recommended default).** The new product does not bid on it; your existing campaign keeps it.

```js
const skip = ['giacca moto', 'abbigliamento moto', 'dainese' /* … */]
await ads(`/blueprints/${BP}/apply`, {
  productToken: 'VENTRA', asins: ['B0XXXXXXX1'], marketplace: 'IT',
  dailyBudgetCapEur: 120, skipSharedTargets: skip,
})
```

**B. Accept it on the record.** Sometimes correct — e.g. the new product is genuinely a better match for that
term and you intend to move the traffic. The decision is stored on the application row.

```js
acceptSharedTargets: ['giacca moto']
```

To skip *all* of them in one go:

```js
const dry = await ads(`/blueprints/${BP}/apply`, { productToken:'VENTRA', asins:['B0XXXXXXX1'], marketplace:'IT' })
const skipAll = dry.plan.conflicts.map(c => c.expression)
```

> **Expect the count to drop sharply.** On AIREON→GALE, skipping all 43 conflicts took positives from
> **137 → 24**. That is not the tool being unhelpful — it is the honest size of what is genuinely *about*
> the new product once you stop duplicating category bids you already own.

Re-run until `plan.allowed === true`.

---

## Step 5 — Go live

Only when `plan.allowed` is `true` and you have read `plan.totals`:

```js
const run = await ads(`/blueprints/${BP}/apply`, {
  productToken: 'VENTRA', asins: ['B0XXXXXXX1'], marketplace: 'IT',
  dailyBudgetCapEur: 120,
  skipSharedTargets: skipAll,
  dryRun: false,                       // ← the only thing that makes it real
})
const APP = run.applicationId
```

**Read the result honestly:**

| `status` | Meaning |
|---|---|
| `APPLIED` | everything created and every campaign got an Amazon id |
| `PARTIAL` | something did not land — **check `notOnAmazon` and `errors`** |
| `FAILED` | no campaign was created |

`notOnAmazon` lists campaigns that exist locally but never reached Amazon. A non-empty list means the write
gate was closed for that market — the campaigns are inert, not live.

---

## Step 6 — Verify in two places

**In Nexus:** open `/marketing/ads/campaigns`, filter to the new names (`IT-VENTRA-SP-…`), and check the
**Amazon Delivery** column. `Live` means the last write reached Amazon; `Pending`, `Failed`, `Sandbox`,
`Gated` or `No write` each mean it did not.

**In Amazon:** open Seller Central → Campaign Manager and confirm one campaign exists with the expected
budget and keywords. Do this on the **first** replication for a product line; the delivery column is
trustworthy afterwards.

Then leave it alone for 24h. The 20-minute settings sync will reconcile Amazon's own state back into the
console, and `/api/health` → `adsIntegrity` will report any problem on its own.

---

## Step 7 — If it went wrong, roll the whole run back

```js
await ads(`/blueprint-applications/${APP}/rollback`, {})
```

This archives **every campaign that run created**, as one unit. Archiving is soft and reversible on Amazon's
side. It does not touch anything that existed before the run.

Review past runs any time:

```js
await ads('/blueprint-applications')
```

---

## Limits — what this does NOT do yet

1. **PAT / product-targeting campaigns are not created.** The AIREON blueprint contains a `PAT` campaign; its
   product targets need a different Amazon API surface. They are counted in `skippedNonKeyword` so you can see
   what was left out — the campaign shell is created, but empty of product targets. **Add those by hand.**
2. **Diff only works within one naming convention.** Comparing this blueprint against `GALE | IT | …`
   campaigns returns noise, because roles are derived from names.
3. **No UI.** Everything is console-driven until a surface is built.
4. **One product per run.** Replicating to three products is three applies.

## If something looks wrong

- `401` — session expired, reload the app.
- `409 refused` — the gate blocked it; the body carries `blockers` and `conflicts`.
- `404 blueprint not found` — wrong id; `await ads('/blueprints')`.
- `PARTIAL` with `notOnAmazon` — the market could not accept writes; nothing is live.
- Anything else — `GET /api/health` and read `adsIntegrity`; it names the problem and the next step.
