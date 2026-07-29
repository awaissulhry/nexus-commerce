# Replicating a campaign structure onto another product — operator runbook

> **Rewritten 2026-07-29.** The previous version of this file told you to paste `fetch()` calls into a
> browser console, because there was no UI. There is now: **Ads → Campaign Builder → Replicate
> Structure**. Everything below is done on that screen.
>
> `/marketing/ads/blueprints` still works — it redirects here.

---

## What this does, and the one thing it refuses to do

It copies a campaign structure — the campaigns, ad groups, keywords, negatives, product and auto
targeting, bids, budgets and placement modifiers — onto a different product, renaming everything on
the way.

It will **not** let you copy a keyword that would put your new product into the same Amazon auction
as something you already run. Amazon's auction is second-price: two of your own jackets bidding on
`giacca moto` raise your own clearing price and split one pool of demand between them. Those keywords
are a **blocking** decision — you resolve each one before anything is created. That gate is the
reason this is safe to use, and there is no way around it.

---

## Before you start

**Writes are live.** A launch creates real campaigns in your Amazon account. IT and DE have written
as recently as this morning; FR and ES are writable but have never had a write reach Amazon, and the
preflight will warn you if you are about to be the first. The five sandbox markets (UK, PL, SE, NL,
IE) are **blocked** — the plan refuses rather than creating a structure that would sit there inert.

**Your naming conventions all work now.** Roles used to be derived from one convention that only 11
of 190 campaigns used. Portfolio, pipe (`GALE | IT | Phrase | Category`), underscore
(`IT_Auto_Close`), token-last (`Auto_Loose_Moss`) and unportfolio'd campaigns all parse.

---

## Step 1 — Source & Products

### Pick what to copy

The tree is **portfolio → campaign → ad group**. Tick at any level. An ad group brings its campaign
with it, because Amazon has no ad group without one.

Do not skip the **No portfolio** group. 128 of 190 campaigns live there, including every
product-targeting structure in the account.

If you saved a structure before, it appears above the tree as **Saved structures** — clicking it
selects the campaigns it was captured from and fills in its product token. Note that this copies what
those campaigns look like *now*, not a snapshot from when you saved it.

### What to copy

Everything is on by default. Two of the toggles change behaviour rather than preference, and say so
on screen:

- **turning off negatives makes the copies WIDER than the source** — they will buy traffic the
  original pays to avoid;
- **turning off auto groups** leaves an Auto campaign with nothing to target at all.

### Naming — usually required, not optional

The product token is guessed from the names you selected. Check it.

Amazon will not accept two campaigns with the same name, and **most of your campaign names do not
contain the product**, so substituting the product alone leaves the name unchanged and the launch is
blocked. Use the prefix/suffix or find-and-replace. The preview shows every old → new name, flags any
that would collide, and flags any that are unchanged.

### Products

The same picker as the other builders. One product ad per product, in every ad group.

### Destination

Market, portfolio, daily-budget cap, and the bid/budget policy: **copy · scale by % · flat value**.

Copying bids verbatim is not neutral. A bid that matured on a product with months of history is not
the right opening bid for one with none — and if the source is bid-suppressed (the AIREON auto
clauses sit at the 2¢ floor deliberately), copying verbatim copies the suppression too.

### Past runs

The same section lists what has already been replicated into this market, with rollback and
raise-bids per run, plus the **drift check** — compare a saved structure against a product's live
campaigns to see what has moved since.

---

## Step 2 — Review & Edit

Everything that would be created, before any of it is. Rename, re-price, or delete at any level:
campaign, ad group, or individual keyword. Deletions strike through and can be restored.

**Conflicts appear inline on the offending keyword**, naming the campaign it would fight:

```
giacca moto donna  BROAD    ⚠ competes with IT-AIREON-SP-Category-Broad +17   [Drop it] [Keep it]
```

- **Drop it** removes that keyword from *every* ad group in the plan.
- **Keep it** records the decision — sometimes right, when the new product is genuinely the better
  match and you intend to move the traffic.

Expect the keyword count to fall sharply. On AIREON → GALE, resolving all 43 conflicts took positives
from 137 to 24. That is not the tool being unhelpful; it is the honest size of what is actually
*about* the new product once you stop duplicating category bids you already own.

You can also **add** keywords here. They go through the same self-competition check as copied ones.

> If you go back and change the source after editing, your edits are refused as a set rather than
> partly applied. Applying the half that still resolves would create something you never approved.

---

## Step 3 — Preflight & Launch

Read, in order: the totals, **what will not be created**, the warnings, and the €/day.

### How it goes out

- **Land at the bid floor** (default) — created and enabled at Amazon's €0.02 minimum, with every
  planned bid remembered. The structure exists and syncs normally but cannot meaningfully spend. One
  click raises it later. **Never paused**: pausing disrupts Amazon's optimisation and forces
  re-learning, which is why this account suppresses with bids instead.
- **Go live now** — created at the planned bids and budgets, spending from the moment it lands.

Use the floor for the first replication of a product line. Look at it in Seller Central, then raise it.

### After it runs

| Status | Meaning |
|---|---|
| `APPLIED` | everything created, and every campaign got an Amazon id |
| `PARTIAL` | something did not land — **read `notOnAmazon` and the errors** |
| `FAILED` | nothing was created |

`notOnAmazon` means those campaigns exist locally but never reached Amazon — the write gate was closed
for that market. They are inert, not live.

From the result panel you can **roll the whole run back** (archives every campaign it created, as one
unit), **raise to the planned bids**, or **save the structure as a blueprint**.

---

## Verify

**In Nexus:** open Ad Manager, filter to the new names, and check the **Amazon Delivery** column.
`Live` means the last write reached Amazon; `Pending`, `Failed`, `Sandbox`, `Gated` and `No write`
each mean it did not.

**In Amazon:** Seller Central → Campaign Manager, confirm one campaign exists with the expected budget
and keywords. Do this on the first replication for a product line; the delivery column is trustworthy
afterwards.

Then leave it 24h. The 20-minute settings sync reconciles Amazon's own state back, and `/api/health`
→ `adsIntegrity` reports problems on its own.

---

## If something looks wrong

- **"N campaign name(s) already exist"** — the rename did not change them. Add a prefix, or a
  find-and-replace.
- **"N keyword(s) would make X bid against campaigns you already run"** — go to step 2 and resolve
  them on the keywords.
- **"X was already replicated in this marketplace on …"** — you have done this before. Check the
  earlier run under **Past runs** before launching a second set.
- **"N of your edits point at … no longer in this plan"** — the source changed after you edited.
  Review step 2 again.
- **`PARTIAL` with `notOnAmazon`** — the market could not accept writes; nothing is live.
- Anything else — `GET /api/health` and read `adsIntegrity`.

---

## Known limits

1. **Sponsored Brands and Sponsored Display are not modelled** (deferred by decision). SB/SD auto
   clauses in a source are reported and not created.
2. **One product per run.** Replicating to three products is three runs.
3. **The drift check needs one naming convention.** Comparing a structure against campaigns named
   differently returns noise.
4. **No resumable drafts.** Closing the builder loses the in-progress setup; saved structures and
   "Replicate again" cover the expensive part.
