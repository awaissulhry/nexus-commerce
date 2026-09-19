# Shared stock between profiles: the simple plan

Date: 2026-09-19
Status: **Steps 1–6 are built and tested, the full test on two test profiles passed, and reordering knows the pool (2026-09-19).** Step 0 is done and live. **Committed on 2026-09-19, not pushed yet** (your "Option 1"): you run the read-only production check, then the push. A push changes the production database. What each step does, how it was proven and what it cannot do yet: the build record.
Where the new code is: a separate copy of the code at `.claude/worktrees/shared-stock`, so half-built work can never reach production by accident. It moves to `main` only when you say "commit".
Based on the research: [`2026-09-16-assortment-engine-plan.md`](2026-09-16-assortment-engine-plan.md). The technical contract and build record: [`2026-09-19-shared-stock-build.md`](2026-09-19-shared-stock-build.md).

---

## 1. The idea, with one example

- You have **Profile A** with **eBay account 1**, and **Profile B** with **eBay account 2**.
- You have **10 jackets** in one warehouse.
- Both eBay listings show **10**.
- A buyer on account 2 buys 1 jacket. **Both** listings now show **9**.

There is only **one** stock number. Both profiles sell from it. We call it **the pool**.

## 2. Words used in this plan

| Word | Meaning |
| --- | --- |
| **Profile** | One business in Nexus. It has its own products, settings and channel accounts. |
| **Listing** | One product on one channel account, in one country. For example: "Jacket, eBay account 2, Italy". |
| **Pool** | One stock number that listings in more than one profile sell from. |
| **Lender profile** | The profile whose warehouse holds the stock. It lends the stock. |
| **Borrower profile** | The profile that sells from the lender's stock. It never gets its own copy of the number. |
| **Owner** | A person with the Owner role in a profile. Only owners can switch a pool on or off. |
| **Link** | One product in the borrower profile that sells from the pool. You switch it with the product switch (§4). |
| **Hold** | Stock kept for an order that is not shipped yet. It is not sold, and nobody else can sell it. |
| **Oversell** | You sell more items than you have. This is the problem we must always stop. |

---

## 3. What is already done (live in production)

| What | Status |
| --- | --- |
| **Stock lock.** Two sales at the same moment can no longer lose an update. | ✅ Live since 2026-09-16 |
| **Share products** from one profile to another, with the other owner's consent. | ✅ Live. No screen yet. Not used in production yet. |
| **First copy** of shared products into the other profile. Each profile gets its own item IDs. | ✅ Live. No screen yet. Not used in production yet. |
| **Stock modes per listing, inside one profile:** "Follow", "Fixed number" and "Paused". You see them on `/fulfillment/stock/sync-control`. | ✅ Live |
| Screens for sharing products | 🟡 Half built on 2026-09-17, never saved to git. Step 5 finishes them. |
| **The shared pool itself** | ❌ Not built. This plan builds it. |

---

## 4. Your question 1: can I unlink and link again, any time?

**Yes.** You get three switches. They go from big to small.

| Switch | What it controls | Choices | Who can use it |
| --- | --- | --- | --- |
| **1. Profile switch** | All of Profile B's products that use A's pool | **Offer**, **Accept** or **Decline**, **Pause**, **Resume**, **End**, **Leave** | An owner of A offers, pauses, resumes and ends. An owner of B accepts, declines or leaves. |
| **2. Product switch** | One product in Profile B | **Use the shared pool** or **Use my own stock** | An owner of B |
| **3. Listing switch** | One listing (one channel account, one country) | **Follow**, **Fixed number**, **Paused** (see question 2) | The profile that owns the listing |

**Rules for the switches:**

- **Nothing starts without both owners.** A offers. B must accept. This is the same consent rule as sharing products.
- **To start again after "End" or "Leave",** A makes a new offer and B accepts it again. "Pause" and "Resume" need no new consent.
- **Only products that came from A can use A's pool.** They are the products A shared with B, and B copied or linked (§3).

**Example:**

1. Jacket, eBay account 2 (Profile B), uses the pool. It shows 9.
2. You switch the product to **Use my own stock**. Profile B has 3 jackets of its own. The listing now shows **3**.
3. Next week, you switch it back to **Use the shared pool**. The listing shows the pool number again. The target is less than 10 seconds. Step 2 measures it and writes down the real time.

**Safety rules (always on):**

- **When a link stops, the listing never keeps an old number.** It goes to **0**, or to the profile's own stock. An old number is how oversell happens. "Pause" works like "End" for the numbers. The only difference: "Resume" brings the links back without a new offer.
- **Two exceptions, and the preview names both:** a listing on **Fixed number** keeps the number you chose, and a listing on **Paused** gets nothing sent (§5). So before you pause or end, you can change them.
- **Before you end or pause, a preview shows the exact numbers.** For example: "12 live listings go to 0. 2 listings are on Fixed number. 1 listing is Paused."
- **Orders already made stay safe.** An order that already holds pool stock still ships, or is cancelled, from the pool, even after "Pause" or "End". Only **new** sales stop using the pool.
- **A product uses one source at a time.** It uses the pool **or** its own stock. Never both added together.
- **Amazon FBA stock is never in the pool.** Amazon controls FBA stock. Only warehouse stock can be lent.
- **The switches are written in the history.** The profile switch and the product switch write a history row in both profiles (who, what, when). Sync Control changes and end times write one too, with the person, or "the end-time job" when a time ends an override. Product details that follow from the other profile are written in the product's history. **Not every older tool does this yet:** changing a listing's mode in the flat files, the product editor, bulk actions or the stock import writes no history row. That gap is older than this plan; the build record lists it.
- **Nothing is deleted when you unlink.** Products, listings and history stay.

---

## 5. Your question 2: can I override the stock for one channel only, for a short time or forever?

**Yes.** The override works on **one listing**. All other listings keep following the pool.

| You want | Use this | Built today? |
| --- | --- | --- |
| Show a number you choose, **forever** (until you change it) | **Fixed number** on that one listing. Example: show 2 on eBay account 2, Italy only. | ✅ Yes, on pool listings too (step 2). |
| Show a number you choose, **for a short time** | **Fixed number + an end date and time.** When the time comes, the listing goes back to "Follow" by itself. It is written in the history. | ✅ **Built** (step 3; the screen in step 5). |
| Stop sending numbers to one channel, for a short time | **Paused + an end date and time.** When the time comes, the pause ends by itself. The listing goes back to what it was before (Follow or Fixed number). | ✅ **Built** (step 3; the screen in step 5). |
| Keep some items back from one listing | **Hold back N.** Example: pool has 9, hold back 2, listing shows 7. | ✅ Yes |

The end date and time use **your own time zone**. The screen shows the zone next to the time.

**Two warnings, said plainly:**

1. **A fixed number is not real stock.** If you set 10 but only 3 are left, you can oversell. The Fixed number screen says so (step 5). The oversell alarm checks pool listings too (step 2), **but today it tells nobody**: it writes a note no screen reads. That gap is older than this plan (build record, "found while mapping" 4).
2. **"Paused" means Nexus sends nothing.** The channel keeps the **last** number it had. If you want the channel to show 0, use "Fixed number = 0" instead.

**One gap today:** on eBay, one variant can sit in more than one eBay listing. For these, today you can only choose "Follow" or "Excluded". Step 3 adds "Fixed number" for them too.

---

## 6. The three problems from the research, and how the plan handles them

### Problem 1: stock updates had no lock

- **What it meant:** two sales at the same moment could lose one sale. With a shared pool, this gets more likely.
- **Status: ✅ FIXED.** Live since 2026-09-16.
- **How:** every stock change now waits for its turn on that product.
- **Proof:** a test runs 20 sales at the same moment. Before the fix, 19 were lost. After, 0 are lost. This test runs before every push to GitHub. It needs Docker. Without Docker, it prints "SKIPPED" and does not stop the push.

### Problem 2: most product saves send no "I changed" signal

- **What it means:** in 52 of 66 files that save a product, the code does not tell anyone that the product changed. So a copy in another profile can miss the change.
- **The fix:** the **database itself** writes a small note each time a shared product changes. The code cannot forget to do this. A helper reads each note and copies the change to the other profile. A nightly check compares both sides and repairs any difference.
- **Important for stock:** the **stock number is never copied**. There is only one number. The same idea protects it: the **database** writes a note each time pool stock changes, whoever changed it. A helper then updates the listings in every profile that uses the pool.

### Problem 3: one database action cannot touch two profiles

- **What it means:** each profile has a wall around its data. That is good, and we keep it. But a sale in Profile B must lower the stock that sits in Profile A.
- **The fix:** 5 **"safe doors"** in the database:

  | Door | When it is used |
  | --- | --- |
  | **Check stock** | B's listings ask how many the pool has. |
  | **Hold an item** | A new order in B (Amazon holds stock until the order ships). |
  | **Give it back** | An order in B is cancelled before it ships. |
  | **Take it out** | An order in B ships, or an eBay sale in B (eBay takes stock at once, with no hold). |
  | **Put it back** | A return in B goes back on the shelf, or a sale that was already taken is cancelled. |

  The research named 4 doors. The 5th ("Put it back") is needed so returns go back into the **one** pool number, not into a second number in B.
- **Each door:**
  1. Checks that A lends stock to B, and that this product is linked.
  2. Locks A's stock number, with the same lock as every other stock change, so nothing else changes it at the same time.
  3. Changes the number.
  4. Writes which profile used the item, and for which order.
- **A's own bookkeeping follows within seconds, inside A:** cost of goods, A's own listings, the "out of stock" check and the history.
- **Profile B never gets direct access** to A's warehouse data. It only sees the "available" number of the warehouses A chose to lend.

---

## 7. The build steps, in order

Each step is tested before the next one starts. **No real pool is switched on before step 7.** Until step 4 is built, a sale in B does not lower the pool, so the pool must not be used for real sales before then.

| Step | What | What changes for you |
| --- | --- | --- |
| **0** | Stock lock | ✅ Done |
| **1** | **The lending permission, the product links and the 5 safe doors.** Tested on a real test database with two test profiles. Includes: two profiles buy the last item at the same moment, 100 times. Only one may win each time. | Nothing visible yet |
| **2** | **The switches.** Profile switch and product switch, with their previews. The rule "go to 0 or to own stock when a link stops". Stock changes reach every profile's listings. **Every** place that works out a listing number uses the pool (sending, checking, the Sync Control page). Listing modes work on pool listings. The oversell alarm watches the whole pool. FBA is refused. | Pool works on test profiles, controlled from the API |
| **3** | **Temporary overrides.** End date and time for "Fixed number" and "Paused". Fixed number for eBay variants in more than one listing. | New choices on the listing |
| **4** | **Orders, returns and shipping.** A sale in B holds and takes stock from A's pool. Cancellations give it back. Returns put it back. B ships from its own copy of A's warehouse address. Cost of goods for B's sales. | B's orders use the pool |
| **5** | **The screens.** Finish the half-built sharing page. The profile switch and the product switch, with previews. "Who owns this pool" and "who sold what" on the stock pages. Built only from the design system. Checked in light and dark mode, with the keyboard only, and at phone width. | You can do everything from the app |
| **6** | **Live product details.** The database notes from Problem 2. Title, pictures and more follow the source profile. A SKU change follows your rule of 2026-09-16: it waits while the product is live. | Product edits in A reach B |
| **7** | **Full test on two test profiles.** Then you decide about production. | Your decision |

**Status on 2026-09-19:** steps 1 to 6 are built and tested, in the separate copy of the code. Nothing is committed or pushed.

**Step 7, the full test (2026-09-19, your "go with option 1, run the full test"):**

- ✅ **The whole story on two test profiles passed**, twice, through the real app: share and copy products, lend stock, switch products, orders, cancellations, returns, "who sold what", end times, live product edits, pause, resume, end. The test database was built the way production will be after a push. The screens were checked in light and dark mode and at phone width.
- ✅ **Two faults found and fixed:** the live product sync would have listened on the wrong database line in production (a change would have waited up to 60 seconds, not 0.1 s); and the borrower's stock page said "restock urgently" for products that sell from the pool.
- ✅ **Risk 7 (a rush of orders):** no unit was lost at any load. One product handles about 130 stock changes a second; above that, the lender's own writes wait too long and fail safely (nothing is lost).
- ✅ **Risk 8 (rights), tested locally:** everything works without a superuser, with the rights production's database owner had on 2026-09-12. Without the one right it needs, the pool would show 0 (it would never oversell).
- ⏳ **Not done: the read-only check in production.** This session is not allowed to read production. The check is ready for you to run (build record §7.6).
- ✅ **Found, not in the plan, now fixed (your option 1):** reordering knows the pool. The lender's reorder numbers and forecast count what its pool sold for the borrower (a cancelled order does not count; a return does not undo a sale). The borrower is not told to reorder products the pool covers; its reorder page says who restocks them. The automatic purchase orders skip them. Build record §8.

What is left before any real use:

- **Screens not built yet:** the "Follow" / "Override" badges and "Follow again" on the product pages (the API and the notices exist).
- **A single edit** in one profile reaches the other in about a tenth of a second. **A bulk edit of 1,000 products** takes about 2 minutes to arrive in full.

**Not in this plan:** mapping settings that follow (research AE.5), rule-based assortments (AE.8), and a limit per profile (your Decision 2: "not now").

---

## 8. Risks you should know

1. 🔴 **Shopify and Sendcloud** messages always go to the first profile today. So a second profile cannot use Shopify, or see carrier tracking, until this is fixed. **eBay and Amazon are not affected.** This plan does not fix it.
2. 🔴 **After a second profile has real data, "turn profiles off" is no longer a safe way back.**
3. 🔴 **A push to GitHub changes the production database.** So nothing from this plan is pushed without your "yes".
4. **Profit for Profile B:** the item cost is in Profile A. How B sees its cost is still open. Step 4 answers it.
5. **One profile can sell out the other.** Both sell from the same number. You chose no limit per profile for now (Decision 2). We can add one later.
6. **Products tracked by lot or serial number cannot use a pool in the first version.** The product switch refuses them and says why.
7. **The stock lock under a rush of orders.** Measured in step 7: no unit lost at any load; about 130 stock changes a second on one product. Production's own busiest minute is still to be read (build record §7.6).
8. **The safe doors run with the database owner's rights.** Step 7 proved locally that they need exactly one right ("bypass row security") and no superuser. Production's owner had it on 2026-09-12; the read-only check in production reads it again (build record §7.6).

---

## 9. Your decisions (answered 2026-09-19)

You said: "for the two decisions, I'll actually go with your recommendations".

| # | Question | Your answer | What it means |
| --- | --- | --- | --- |
| **1** | Can an override end by itself? | **Yes, with an optional end date and time.** | You set "Fixed number 2 until Monday 09:00". On Monday the listing goes back to the pool by itself. It is written in the history. This is built in **step 3**. |
| **2** | A limit per profile? (Example: "Profile B may show at most 20 from the pool.") | **Not now. Maybe later.** | Nothing is built for this. "Fixed number" and "Hold back" cover one listing. A limit can be added later as one setting on the lending permission. |
| **3** | Build it? | **"All steps, in order"** (2026-09-19) | Steps 1 to 6 are built one after the other. Each must pass its tests before the next starts. Nothing is committed or pushed. Step 7 (production) stays your call. |

---

## For the engineers (you can skip this)

| Plain word | Technical name |
| --- | --- |
| Lending permission (profile switch) | `StockPoolGrant` (global): lender = `ownerWorkspaceId`, borrower = `workspaceId`, lent WAREHOUSE `locationIds`. Same consent life cycle as `AssortmentShare` (research §14). |
| Link (product switch) | `StockPoolLink` (borrower-owned): borrower product ↔ lender product through an active `CatalogLink`. One active link per product. Never deleted. |
| Database notes for stock | `StockPoolTask` (per-business queue), written by triggers on `StockLevel`, `StockPoolLink`, `StockPoolGrant` and `CatalogLink`; claimed by a per-business worker plus a post-commit kick |
| 5 safe doors | `SECURITY DEFINER` functions `nexus_pool_available`, `nexus_pool_reserve`, `nexus_pool_release`, `nexus_pool_consume` + `nexus_pool_take`, `nexus_pool_put_back` |
| One ledger for every listing number | `loadSyncLedgers` — the only source of the `ledger` input to `resolveIntendedQuantity` / `resolveMembershipIntended` |
| Stock lock | `lockProductStock` in `apps/api/src/services/stock-lock.ts`, commit `8b279db5f` (research §13); the doors take the same `FOR NO KEY UPDATE` row lock on the lender's `Product` row |
| Database notes for product details | capture trigger + `AssortmentChange` queue + worker + repair job (research §3.2, §12.6) |
| Listing switch | Sync Control modes, `resolveIntendedQuantity` in `apps/api/src/services/sync-control-core.ts` |
| Fixed number / Paused / Hold back | `followMasterQuantity=false` (PINNED) / `syncPaused` / `stockBuffer` on `ChannelListing` |
| eBay variant in more than one listing | `SharedListingMembership.followPool` (only FOLLOW or EXCLUDED today) |
| End date and time | new, additive: `pinnedUntil` / `pausedUntil`, and a per-business job that ends them, audited in `SyncControlAudit` |
| Research steps | Step 1–2 = AE.6, Step 3 = new (this plan), Step 4 = AE.7, Step 5 = the UI lane (research §7, §19), Step 6 = AE.4, Step 7 = AE.9 |
