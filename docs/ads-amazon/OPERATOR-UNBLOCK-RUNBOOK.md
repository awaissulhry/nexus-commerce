# Operator unblock runbook — the four things code cannot do

Four items block the remaining ads work. None of them are code problems, which is
why they have sat while everything around them shipped. Each section says what is
blocked, exactly what to do, and how we confirm it worked.

Ordered by value-per-effort. #1 unblocks the most.

---

## 1. One real Seller Central bulksheet download

**Blocks:** Sponsored Brands + Sponsored Display sheets, Amazon's true portfolio
columns, and — downstream of both — scheduled bulksheet imports.

**Why nothing else substitutes.** Amazon publishes no machine-readable schema for
bulksheets, and its docs site is a client-rendered SPA. We know the Sponsored
Products columns because we have seen them. For SB, SD and Portfolios we would be
guessing, and a guessed layout is worse than no sheet: it produces a file that
looks right, imports cleanly, and writes the wrong things. That is the failure
mode this whole engagement exists to remove, so the code deliberately refuses to
emit those sheets rather than invent them (`build-workbook.ts` header).

### Steps

1. Go to **advertising.amazon.com** and sign in.
2. Top-left account/marketplace picker → select the **Italy** profile (the one
   whose campaigns we manage).
3. Left nav → **Sponsored ads** → **Bulk operations**.
   *If the label differs, look for "Bulk operations" or "Bulksheets"; Amazon
   moves this between the sidebar and the "Measurement & reporting" group.*
4. In **Create a custom spreadsheet for download**:
   - **Date range:** last 30 days is fine — we need the shape, not the numbers.
   - **Ad products:** tick **Sponsored Products, Sponsored Brands AND Sponsored
     Display**. This is the one setting that matters. If SB/SD are unticked the
     download is useless for this purpose.
   - Include paused/archived if offered — more entity types means more of the
     grammar visible.
5. Click **Create spreadsheet for download**. It queues; it can take a few
   minutes for a large account.
6. When it flips to ready, **Download** the `.xlsx`.

### What I actually need from it

Only the **header rows** and a **handful of sample rows per sheet** — enough to
see how Amazon formats bids, dates, states and IDs. If you would rather not hand
over live campaign data, this is entirely reasonable:

- Open the file, and on each sheet delete all but the first ~5 data rows.
- Save as `.xlsx` and give me that.

Header rows alone unblock the column sets; the sample rows are what stop me
guessing formats (e.g. whether a date is `2026-07-29` or `20260729`).

### Hand it over

Drop it anywhere and tell me the path, e.g. `~/Downloads/bulksheet.xlsx`.
Do **not** commit it to the repo — it is account data and the repo is not the
place for it.

### How we confirm

I read the real headers, replace the guessed portfolio columns, add the SB/SD
sheets, and the round-trip tests get a real fixture instead of one I invented.

---

## 2. SQS policy grant for the AMS change datasets

**Blocks:** near-real-time notification that someone edited in Seller Central.
Today we only learn about external edits from a 20-minute poll.

**Important: do step 1 before assuming anything about the policy.** The code side
is already done — `AMS_DATASETS` includes the four change datasets and
`budget-usage`, the endpoint is idempotent per dataset, and the consumers exist.
Rather than me guessing Amazon's principal ARNs (they differ by region and have
changed), the fastest correct path is to attempt the subscription and let Amazon
tell us exactly what its destination policy check rejects.

### Step 1 — attempt it and capture the error

With the API running, call:

```
POST /advertising/marketing-stream/subscriptions
{ "allDatasets": true }
```

It tries every dataset independently and returns a per-dataset result, so
already-subscribed ones cannot abort the rest. Send me the response.

Expected: the six performance datasets report `ok: true` (already subscribed);
the five new ones fail with a message naming the destination-policy problem.

### Step 2 — apply the grant Amazon asks for

In the AWS console → **SQS** → the queue behind `NEXUS_AMS_DESTINATION_ARN`
→ **Access policy**. Add a statement allowing Amazon's SNS principal to
`sqs:SendMessage` to that queue ARN, scoped by `aws:SourceArn` to the topic(s)
named in step 1's error.

Two things to check while you are there:
- `NEXUS_AMS_DESTINATION_ARN` is the **queue ARN** (`arn:aws:sqs:...`).
- `NEXUS_AMS_SQS_QUEUE_URL` is set, or the poller stays dormant and nothing is
  consumed even once subscriptions exist.

### Step 3 — re-run and verify

Re-run the same POST, then:

```
GET /advertising/marketing-stream/subscriptions
```

All eleven datasets should be listed. Within a few minutes of any edit made in
Seller Central, the campaign's `settingsSyncedAt` should move without waiting for
the 20-minute poll — that is the observable proof it is live.

---

## 3. eBay seller standing — error 35077

**Blocks:** launching the general CPS eBay campaign. Every write returns 35077.

**What it is.** 35077 is an account-eligibility refusal, not a bug in the payload
— eBay declines to run Promoted Listings for the account in its current standing.
No code change can clear it; it resolves at the account level and then the
existing write path works unchanged.

### Steps

1. eBay **Seller Hub** → **Performance** → **Seller level** (or "Seller
   standards").
2. Check the **Italy / eBay.it** standing specifically, not the global one — the
   campaign is IT.
3. You are looking for **Above Standard** or **Top Rated**. **Below Standard**
   is what produces 35077.
4. If Below Standard, the page lists the failing metric — usually one of:
   - transaction defect rate,
   - late shipment rate,
   - cases closed without seller resolution.
5. Standings are re-evaluated **monthly on the 20th**. A metric fixed today
   changes standing at the next evaluation, not immediately.
6. Also confirm on the same screen that Promoted Listings is available for the
   account — some formats require an active eBay Store subscription.

### How we confirm

Retry the campaign launch. If 35077 is gone the write succeeds with no change on
our side. If a *different* error appears, that one is mine to fix — send it to me.

---

## 4. The eBay ad-pool decision — I need a choice, not a task

This is the only one that is a judgement call rather than a procedure.

**The problem, stated plainly.** When the same stock is promoted through more than
one campaign, you can pay twice for one sale, and your own listings can bid
against each other. Today nothing detects it. The existing check only looks at
Cost-Per-Sale campaigns and filters on `fundingModel: 'COST_PER_SALE'`, so **a
listing sitting in both a CPS and a CPC campaign — exactly the double-fee case —
is never flagged.**

**Why the original spec cannot be built as written.** It groups listings by
`ChannelListing → ProductVariation → canonical SKU`. `ProductVariation` is a
deprecated empty table with no foreign key from `ChannelListing`, and
`Product.sku` is `@unique`, so one SKU cannot span two families. I verified that
against the schema; the plan is unimplementable as specified. The phenomenon is
still real — it just travels through `SharedListingMembership` instead.

### Your options

**A. Targeted conflict detection — small, fixes the proven case.**
Widen the existing check to span funding models, so a listing in both a CPS and a
CPC campaign is flagged. Days, not weeks. Catches the double-fee case that is
actually costing money. Does not model attribution tails or stockout overspend.

**B. Pool on `SharedListingMembership` — medium, matches reality.**
Treat a shared-SKU group as the unit for ad decisions: one pool, one campaign,
one budget. Fixes self-competition and multiplied attribution properly. Bigger
change, touches campaign build and the automation engine.

**C. Full pool abstraction — large.**
Option B plus the remaining invariants: armed-until windows, the 30-day
attribution tail, stockout overspend. This is the spec's ambition, rebuilt on a
foundation that exists.

### My recommendation

**A now, B when you have evidence you need it.** A is cheap and closes the leak
you can actually observe. B is a real architectural commitment and I would rather
size it against a month of A's conflict reports than against a spec whose
construction path already proved unbuildable once.

**What I need from you:** just "A", "B" or "C". Then I will write the plan for it
and wait for your approval before any code, as usual.

---

## Ordering

1 first — it unblocks the most and costs you about ten minutes.
3 is quick to check and may already be fine.
2 needs an AWS session, so batch it when you are in the console.
4 is a reply, not a task.
