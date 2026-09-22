# The Product Sheet — one research file, in plain words

Date: 2026-09-22.
**Status: research only. No code was changed. Nothing was built.**

> **🔴 CORRECTIONS (2026-09-22).** Eight claims below were measured false or closed after this file
> was compiled; read `PLAN.md` Part 1 and amendments A-1, A-7, A-9, A-10, and `PROGRESS.md`, before
> acting on any of them: (1) *11 untracked production migrations* — 0 drift both ways (A-1);
> (2) *the delist cascade destroys the queue rows* — rows carry no FK; unpublish is refused, not
> destroyed (A-7); (3) *anyone with `products.edit` can delete a live Amazon listing* — false; the
> hole was eBay's edit permission, closed (A-10); (4) *"Unpublish (recommended)" is an irreversible
> delete* — wrong diagnosis; the orphaning delete is now refused (Correction 3, Step 1.2);
> (5) *route price through `matrix-write.service.ts` and retire `PATCH /channel-pricing`* — no; the
> door is `writeChannelPrices` and the route was fixed (Corrections 1–2); (6) *a repo-root test run
> reaches production* — refused by the R-VT-12 guard (A-6); (7) *0 of 198 attributes required* —
> 486 rows; 5 mirrored locally; a channel coordinate already had 8 of 163 (A-16); (8) *the Shared
> `groupBy` has no `where`* — narrowed and measured (Step 2.4).
> Review: [PLAN-REVIEW-2026-09-22.md](PLAN-REVIEW-2026-09-22.md) §5.3.

This is a compiled file. It takes everything we already researched about the product sheet
and puts the useful parts in one place, in simple language.

**If you read one page, read [Part 1](#part-1--the-answer-in-one-page).**

---

## Contents

| Part | What it tells you |
|---|---|
| [0](#part-0--words-you-need) | Words you need. A small dictionary. |
| [1](#part-1--the-answer-in-one-page) | The answer in one page. |
| [2](#part-2--the-goal) | The goal, written as a test we can pass or fail. |
| [3](#part-3--how-the-best-tools-are-built) | How the best tools in the world are built. Seven layers. |
| [4](#part-4--where-we-are-today) | Where we are today. What works. What is missing. |
| [5](#part-5--the-seven-dangers) | The seven dangers. Fix these first. |
| [6](#part-6--us-against-the-industry) | Us against the industry. Where we win. Where we lose. |
| [7](#part-7--the-three-rules) | The three rules that fix most of this. |
| [8](#part-8--the-plan-in-order) | The plan, in order. |
| [9](#part-9--decisions-only-you-can-make) | Decisions only you can make. |
| [10](#part-10--what-not-to-do) | What NOT to do. |
| [11](#part-11--what-we-have-not-measured) | What we have not measured. The honest holes. |
| [12](#part-12--where-the-details-live) | Where the details live. |
| [13](#part-13--what-would-actually-change) | 🆕 **What would actually change.** The screen, and what it does. Before and after. |
| [14](#part-14--what-breaks-at-thousands-of-products) | 🆕 🔴 **What breaks at thousands of products.** The short version. |

---

## Part 0 — Words you need

Read this first. The rest of the file uses these words.

| Word | What it means |
|---|---|
| **Channel** | A place you sell. Amazon, eBay, Shopify, Etsy, WooCommerce. |
| **Market** | A country on a channel. Amazon Italy. Amazon Germany. |
| **Listing** | One product, live on one channel, in one market. |
| **Master** | The truth. The product's own data. It belongs to you, not to a channel. |
| **Scope** | Which view you are in. Master, or one channel. |
| **Coordinate** | One exact spot: product + channel + market + account + alias. |
| **Attribute** | One field on a product. Colour. Size. Title. Price. |
| **Family** | A group of products that share the same set of attributes. |
| **Mapping rule** | A rule that changes a value on its way to a channel. |
| **Override** | A value you typed over the inherited one, at one coordinate. |
| **Payload** | The package of data we send to a channel. |
| **Readiness** | Is this listing complete enough to publish? |
| **Presence** | Is this listing on or off? |
| **Provenance** | Where the value on screen came from. |
| **Gate** | A script that blocks a push when a rule is broken. |
| **The studio** | Our product sheet. It lives at `/products/[id]/edit/studio`. |

**One more word: fidelity.** Fidelity means "what you see is what we send". It is the
promise the whole product rests on. Today we have never tested it.

---

## Part 1 — The answer in one page

### What we built

One spreadsheet page that edits a product everywhere it sells.

- Rows are products and their variants.
- Columns are fields.
- Four dials change the view: **scope**, **market**, **language**, **column view**.
- Master is the truth. A channel copies Master unless a rule changes it, or you type over it.

**The sheet is good.** We checked it against the market. The shape is right. This file does
not ask you to redesign anything.

### The one sentence that matters

> **The sheet is the right sheet. What is missing is a definition of "right", one writer per
> field, and proof that what you see is what we send.**

### The three problems, in order of pain

| # | Problem | In plain words |
|---|---|---|
| **1** | **Some buttons destroy data you cannot get back** | "Unpublish (recommended)" is really a **delete** on Amazon and eBay. It is the default. |
| **2** | **The same field has more than one owner** | Price has **three** writers. A child's size and colour live in **three** stores that disagree. |
| **3** | **Nothing defines "complete"** | We have 198 attribute definitions. **Zero** of them are marked required. So "Ready 100%" means nothing. |

### Why these three problems exist

Every architecture problem we found is a **duplicate**, not a missing feature.

Two price writers. Two payload builders. Three axis stores. Two metafield homes. Eleven tabs.
Two readiness vocabularies.

**Not one of them is a missing feature. They are all forks.**

Forks are what you get when many sessions build on one shared tree and nothing is committed.

🔴 **The alarm:** 11 database changes are live on production, untracked in the repo, and
**5 of them have no owning session.** Nobody can name who applied them.

### So the first recommendation is not about code

> **Stop building in parallel lanes. Finish one thing. Commit it. Then start the next.**

Everything else in this file assumes you do that.

---

## Part 2 — The goal

Your goal, in your words:

> **"List and manage listings across several channels with the least effort, while keeping
> proper control over each and everything."**

That is two halves. They pull against each other. Good tools hold both.

Let us turn it into tests we can pass or fail.

### Least effort — the tests

| # | Test | Can we pass it today? |
|---|---|---|
| E1 | Type a value once. It reaches every channel that needs it. | 🟡 Partly. The chain works in code. Never tested live. |
| E2 | Edit 100 rows in one gesture. | 🟢 Yes. Paste and fill-drag work. |
| E3 | Export, edit in Excel, import back. | 🔴 No. Export works. Import is not on the sheet. |
| E4 | Add a new channel without redoing your catalog. | 🔴 No. See Part 6, problem 1. |
| E5 | Translated values fill in by themselves. | 🔴 No. The parts exist. Not wired. |

### Proper control — the tests

| # | Test | Can we pass it today? |
|---|---|---|
| C1 | Nothing destructive happens by accident. | 🔴 No. The destructive option is the **default**. |
| C2 | Every field has exactly one owner. | 🔴 No. Price has three. |
| C3 | You can see what will be sent, before you send it. | 🔴 No. Publish has no preview. |
| C4 | You can undo a publish. | 🔴 No. |
| C5 | You can see what the channel actually holds now. | 🔴 No. We never read back. Not once. Ever. |
| C6 | Every change records who did it. | 🟡 Partly. Removals record nothing. |

**Score: 1 pass out of 11.**

That is the honest starting line. It is not as bad as it looks — most of the failures are one
ruling and one line of code away. Part 8 puts them in order.

---

## Part 3 — How the best tools are built

Every serious product tool in the world has the same seven layers. The names change. The
shape does not.

```
  1. GOLDEN RECORD     One attribute model. Families. Inheritance. Language-aware.
         |
         v
  2. REQUIREMENTS      Per channel and market: required / optional / forbidden.
                       Plus caps, closed lists, shapes.
         |
         v
  3. COMPLETENESS      A score worked out FROM layer 2. Never typed in by hand.
         |
         v
  4. MAPPING           Master value -> channel value. Written as rules, not code.
         |
         v
  5. GOVERNANCE        Workflow. Approvals. Audit. Who changed what.
         |
         v
  6. SYNDICATION       Build payload -> preview -> publish -> record -> undo.
         |
         v
  7. RECONCILIATION    Read back what the channel ACTUALLY holds. Compare. Alarm on drift.
```

### The one idea that matters most

> 🔴 **The channel never decides what is in your catalog. It only decides what it will accept.**

Layer 1 flows down. Layer 2 sets limits. **The arrow never points back up.**

This single idea answers most of your open questions. Keep it in your head for Part 6.

### Our layer score

| Layer | Us |
|---|---|
| 1. Golden record | 🟡 The model exists in the database. It does almost no work. |
| 2. Requirements | 🔴 Exists in the schema. **Zero attributes are marked required.** |
| 3. Completeness | 🔴 The display exists. It has nothing to count. |
| 4. Mapping | 🟢 Built and good. Rules exist for Amazon IT/DE OUTERWEAR only. |
| 5. Governance | 🔴 The workflow table exists. Anyone who can edit can delete a live listing. |
| 6. Syndication | 🟡 We can publish. No preview, no diff, no undo. |
| 7. Reconciliation | 🔴 **Does not exist at all.** |

Layers 2, 3 and 7 are the whole story. Layer 2 is cheap. Layer 7 is the one that turns every
claim in every document from a guess into a number.

---

## Part 4 — Where we are today

### What works (checked in the code)

| Thing | State |
|---|---|
| The page shape, grid engine, 36px rows, 520px drawer | 🟢 Built and measured to the pixel |
| Backend reads, readiness, history, restore, snapshots | 🟢 Built |
| Amazon attribute writes, with a version check and a read-back | 🟢 Built |
| Formulas (about 32 functions, preview, bulk apply, undo) | 🟢 Built |
| Workbook import and export, run on real data | 🟢 Built |
| The mapping engine | 🟢 Built |
| Variations: Variants page, Matrix page, theme column | 🟢 Built end to end |
| The language axis | 🟢 **Shipped and live.** Zero differences over 1.17 million checks |
| Amazon and eBay always merge the sheet's mapping into the payload | 🟢 Verified in code |
| A missing translation refuses the sync instead of sending half | 🟢 **Keep this. It is good.** |

### Three things our own older documents got wrong

This matters, because these three claims changed what people thought to build.

| # | We used to believe | The truth |
|---|---|---|
| 1 | "Channel writes go to `overrideData` and nothing reads it" | ❌ **False.** The publish path reads it. Your override is sent. |
| 2 | "There is no channel price column in the sheet" | ❌ **False.** eBay has one. It writes the column the push reads. |
| 3 | "Shopify metafields are not in the sheet" | ❌ **False.** They are sheet columns with a working editor. |

**The lesson, and it applies to this file too:**

> **A document can be confidently wrong. Check the line, not the sentence.**

### What is missing

**The big one:** the studio has **no listing object**. There is only a `row.listing` hidden
inside a drawer pane. So pause, relist, delist and take-down have nowhere to live.

An audit on 12 September found 180 problems. Its conclusion: all 180 are that one absence.

**Not built at all:**
- The whole Presence programme (turn listings on and off). No read API. No Listings tab. No
  writers. **The production database change was never applied.**
- Channel operations: pull from channel, snapshot and restore, broadcast, apply to siblings,
  field lock, fitment, A+, PDP preview, FBA and FBM.
- **Zero alias-group verbs exist.** So there is nothing to put on a bulk action bar.

**Built but wrong:**
- The delist cascade. See Part 5.
- A closed Amazon market reads "live · selling". A suppressed listing reads "live".
- Unticking a variant is local only. The size stays on sale.
- Paste and fill can write a value over a cap, or off a closed list. A value you could not type.
- eBay readiness has no category, policy, image or fitment rules. So an eBay chip can read
  green and then fail at publish.

### What no code can fix

These are data and access problems. They block proof, not progress.

| Problem | Size |
|---|---|
| Listings never synced | **90%** |
| Listing coordinates missing product data | **976 of 977** |
| Child listings with no variation theme | **227 of 228** |
| `ReadinessIndex` rows on production | **0** — so every readiness chip says "Not computed" |
| `BuyBoxHistory` | Empty |
| eBay credentials | **Fail to decrypt** |
| Amazon OAuth | Returns **`invalid_grant`** |

🔴 **Those last two matter most.** While they are shut, **no live test can run at all.**

---

## Part 5 — The seven dangers

Everything here is in the code today. These are not risks. They are live.

| # | The danger | Why it is bad |
|---|---|---|
| **1** | **"Unpublish (recommended)" is an irreversible delete** on Amazon and eBay | It is the **default**. On Amazon it throws away the ASIN link and the reviews attached to it. No record is kept. |
| **2** | **Deleting a product makes its delist queue rows, then deletes them in the same transaction** | So **no delist ever runs. Anywhere. On any channel.** |
| **3** | **Anyone with `products.edit` can delete a live Amazon listing** | No kill switch. No separate permission. |
| **4** | **Three writers on the price column, one version check between them** | Two people editing price on two pages silently overwrite each other. **The safe page loses.** |
| **5** | **Paste and fill commit values over a cap or off a closed list** | A corner-drag writes values you could not type by hand. Across a hundred rows. |
| **6** | **A test run started from the repo root points at the production database** | One wrong folder. |
| **7** | **A database password is in git history** | Rotation is still open. |

**Dangers 1, 2 and 3 are the only items in this whole file that destroy something you cannot
get back.** Nothing should jump ahead of them.

---

## Part 6 — Us against the industry

We compared ourselves against Akeneo, Salsify, inriver, Stibo, Plytix, Channable, Rithum,
Sellercloud, Linnworks, Feedonomics and Shopify.

### Where we are ahead

Give yourself credit. Several of these are genuinely ahead of the market.

| # | What | Why it is ahead |
|---|---|---|
| 1 | **Per-cell provenance: 11 layers, 8 states, each with a glyph AND a word** | Plytix ships three states. Akeneo ships none per cell. Colour is our third signal, not the first. |
| 2 | **Master → channel → market → language shown per cell** | Akeneo has channel and language, no market. Marketplace tools have market, no language. **Nobody does all four.** |
| 3 | **Formula engine with a Pricing group, and `rule("name")` calling a saved rule** | Rithum's own custom functions explicitly cannot call each other. |
| 4 | **Export refuses to hand over a partial file** rather than give you a misleading one | **No competitor documents this.** |
| 5 | **A pending translation refuses the sync** instead of sending half a payload | This is your "no inconsistency" rule, already enforced in code. |
| 6 | **Readiness has ONE definition.** The sheet never recomputes it locally | So two screens structurally cannot disagree about 71%. |
| 7 | **The Matrix writer uses compare-and-set** | Correct. This is the model everything else should copy. |
| 8 | **An absent thing is stated, not hidden** | A disabled scope keeps its reason. A non-participating market is named. Rare, and a real quality signal. |

### Where we are behind — the five that cost the most

#### 🔴 1. The channel is driving the catalog. The master model is asleep.

**This is the biggest one. It is the root of two of your questions.**

The master model exists in the database, Akeneo-shaped, with per-channel `required` flags.
But it does almost no work, for three checked reasons:

1. **198 attribute definitions. `required` is set on ZERO of them.** So "Ready 100%" is true
   for everything and means nothing.
2. **A per-channel requirement is thrown away.** One line in `family-sheet-schema.ts:38`
   treats "required on Amazon" as "not required at all". The one Akeneo idea that makes
   requirements useful is flattened away at the point of use.
3. **Channel attributes leak into the master view.** What "Shared" contains is decided by
   which listing rows happen to exist in your workspace.

**Why this matters more than it looks.** Every channel-driven catalog hits the same wall.
You cannot answer "what does this product need?" without naming a channel. You cannot add a
channel without redoing your catalog. And a channel schema change edits your product model
behind your back.

#### 🔴 2. The sheet is becoming a second writer, not a second view.

The sheet's eBay price cell and the Matrix page both write the same database column. Only
the Matrix checks the version.

The standard: **one write path per field, many read surfaces over it.** Akeneo's grid, form,
mass-edit and API all funnel into one save path with one validation pass. The grid is a
**client** of the model, never a peer of it.

We already wrote this rule down — *"one field, one writer, one store"* — and it is already
broken in production, on the most expensive field in the system.

#### 🔴 3. There is no read-back. Layer 7 does not exist.

**No live channel write has ever been made and read back. For any channel. Ever.**

The standard closes the loop. Salsify and Syndigo show per-channel status and rejection
reasons. Feedonomics and Channable push channel errors back onto the offending row. Amazon's
own API returns an `issues[]` array per submission that mature tools store.

**This is the layer that turns "we sent it" into "they have it".** Without it, your fidelity
promise can only ever be half-proven. The other half is *what the channel now holds*, and
nothing in this system looks.

**Good news:** we already have the shape for it. `ReadinessIndex` is a per-coordinate computed
table. A `ChannelDrift` row with the same shape is the obvious sibling.

#### 🔴 4. Publish has no preview, no diff and no undo.

Channable shows the affected-item count and a "Before this rule / After this rule" view
before you commit. Rithum previews a rule against a named SKU.

We have exactly this — **for formulas.** A zero-database preview endpoint, live in the editor.
It is genuinely good.

**We do not have it for publish, which is the write that costs money.**

The standard: a publish is a **job**. Staged, diffed, approved, run, recorded, revertible.
Ours is fire-and-hope.

#### 🔴 5. We are building the completeness display before the requirements it counts.

The completeness column with a hover popup is the most valuable of your five layout asks. But:

- **0 attributes are required**, so completeness has nothing to count.
- **Production has 0 readiness rows**, so the column would read "Not computed" on every row.

**This is an ordering mistake, not a design mistake.** The design is right. It is queued wrong.
You would be building a fuel gauge with no sender unit in the tank.

### Three smaller gaps

| # | Gap | Plain words |
|---|---|---|
| 6 | **Language is a dial, not a property of the value** | Neither publish path passes your language. Both fall back to the market's first language. So on Amazon·IT with German picked, the sheet shows German and the push sends Italian. In Akeneo the *value itself* is stored per language, so there is no "current language" a publisher can forget to pass. |
| 7 | **Governance is in the schema, not in the flow** | The workflow table exists with a real pipeline. But today anyone with `products.edit` can delete a live Amazon listing. Enterprise buyers ask for approvals and audit trails **before** they ask for features. |
| 8 | **Safety defaults are inverted** | The standard, without exception: **delist ≠ delete.** End the offer. Keep the listing record, the identifiers, the history. Deletion is always the deliberate, hard, audited path. Calling the irreversible one "recommended" is the most dangerous single string in the product. |

### What the industry says to build next

From our vendor research of 2 September, re-ranked against the measured code. Ranked by
(how often it is used × how much it costs to be wrong).

| # | Item | State |
|---|---|---|
| 1 | **Validation on paste and fill-drag** | Designed, not built. A **shipped** feature creates bad data today. |
| 2 | **Import on the sheet** (the round-trip's return leg) | Designed, not built. Export is honest; data goes out and cannot come back. |
| 3 | **A bulk job you can undo** | Designed, not built. Akeneo, Plytix and Shopify all document **no undo**. This is open ground. |
| 4 | **Blank-cell rules stated on screen** | Designed, not built. Shopify: a blank cell overwrites. Amazon: `Update` wipes, `PartialUpdate` does not. **No tool in the market surfaces this at the moment of decision.** |

Items 3 and 4 are places where the whole industry is weak. That is where "best in the
industry" is actually available to us.

---

## Part 7 — The three rules

Most of what is broken traces back to three rules. Two of them we already wrote down and then
broke ourselves.

### Rule 1 — One field. One writer. One store.

> **The sheet is another HOST for a value. Never another OWNER of it.**

| Where it is broken today | How |
|---|---|
| Price | Two writers on one column, right now |
| A child's size and colour | **Three** stores that disagree |
| Shared scope columns | Decided by a side effect, not a stated source |
| Translated values | A factual value should have one store: **the code.** Labels are a view of it, never a second store. |

### Rule 2 — Put the rule in the engine. Prove it with a gate.

We paid for this lesson once. Two column builders drifted and caused silent channel gaps.

**Today two payload builders exist with nothing asserting they agree.**

### Rule 3 — The channel never decides what is in your catalog.

> **The family decides which attributes a product has.
> The channel decides which of them are required and what shape they take.
> Connection state decides only what you can publish, never what you can store.**

This is the one from Part 3. It is worth repeating because it answers the question you asked
about the Shared scope, and because it prevents a bug you have not hit yet: **if you scope
columns by connection, then disconnecting a channel makes columns vanish from your catalog.
Your data model would depend on an OAuth token's health.**

### What "smart and dynamic" has to mean here

You asked for the sheet to be "extremely smart and dynamic". This is the one place to push back.

**Dynamic is not the enterprise virtue. Declarative is.**

Every "make it smart" feature adds a second place a rule can live. This codebase has paid for
that twice already.

Your real goal — *least effort across channels* — is reached by **fewer paths, not cleverer
ones**:

> One resolver. One writer per field. One contract per page. **One gate that fails when a
> second appears.**

Smart-looking behaviour in a product tool is nearly always a **rule engine plus good
defaults**, not bespoke logic per surface.

---

## Part 8 — The plan in order

Four steps. The order is the point. Each step needs the one before it.

### Step 0 — Stop the parallel lanes

> **One lane at a time. Each one ends in a commit. Until the ledger is clean.**

🔴 Settle what gets committed. **11 production migrations are untracked. 5 have no owner.**
That is not a backlog problem. It is a control problem, and every other defect in this file
is downstream of it.

Everything below assumes this.

### Step 1 — TODAY: stop live damage

Each is small. Each stops something that costs real money or real data **right now**.

| # | Do this | Size |
|---|---|---|
| 1 | **Make the sheet's eBay price cell read-only.** Drop `editable` in `channel-specs/ebay.ts:104` | One flag |
| 2 | **Stop "Unpublish (recommended)" being the default.** Rename it to **Delist**. Make delete the deliberate path | A label and a default |
| 3 | **Gate `deleteListingsItem`.** Make it honour the kill switch. Stop `products.edit` deleting a live listing | A permission check |
| 4 | **Fix the delist cascade.** Today a hard delete creates its delist rows then deletes them in the same transaction | A foreign key rule |

**Do not bundle these with anything else.** And note item 4: items 1 to 3 are pointless if
delist itself is broken.

### Step 2 — THIS WEEK: build the model

Small. Three of the four are a ruling plus one line. Everything downstream depends on them.

| # | Do this | Why it is first |
|---|---|---|
| 5 | **Mark the required attributes.** And stop throwing away per-channel requirements at `family-sheet-schema.ts:38` | 0 of 198 are required today. **Completeness and fidelity both count requirements.** Neither can be built before this. |
| 6 | **One writer for price.** Route the sheet's price cell through `matrix-write.service.ts`. Retire `PATCH /channel-pricing` | Makes item 1 permanent. Inherits the version check, the parent guard and the permission check for free. |
| 7 | **Rule on what the language dial means, then pass the language through both publish callers** | The publish ignores your language today. Two lines, after one ruling. |
| 8 | **Approve and run the readiness reconcile on production** | Production has **0 readiness rows**. Every readiness, variation and completeness screen does nothing until this runs. |

### Step 3 — NEXT: prove it

You cannot claim "100% accurate" until these exist. Nothing here is big.

| # | Do this | Why |
|---|---|---|
| 9 | **Fix the two shut doors.** eBay credentials fail to decrypt. Amazon returns `invalid_grant` | 🔴 **No live test can run at all until this is fixed.** |
| 10 | **Run the four measurements** (below) | Each is cheap. Each changes what gets built. |
| 11 | **Add a parity gate between the two payload builders** | Nothing asserts they agree. This lesson was paid for once already. |
| 12 | **Make one live write, and read it back** | 🔴 This has **never been done, on any channel, ever.** It is the single claim the whole programme rests on. |
| 13 | **Validate paste and fill** | A shipped feature creates bad data today. The industry research ranked this #1 three weeks ago. |

#### The four measurements

| # | The measurement | What it settles |
|---|---|---|
| **M1** | Type a distinctive value into one Amazon·IT channel cell. Capture the payload. Is the value in it? | Whether an override really reaches the channel. A read-through is not a measurement. |
| **M2** | One product, one coordinate. Dump the sheet's values. Dump the payload. **Diff them and count** | **The honest size of your whole fidelity gap, as a number to drive to zero.** |
| **M3** | Set a coordinate to a non-default language. Capture the payload. Which language is in it? | Confirms the language ruling before you make it. |
| **M4** | Open Shared on one product. For each column, name which coordinate declared it. Count the ones whose only declaring channel is not connected | Whether the Shared scope is a bug to fix or a design to document. The count is also the size of the fix. |

#### Four rules for every measurement

These were learned in this programme. They were paid for.

1. **Use a positive control.** A run that finds nothing must be shown capable of finding something.
2. **Run them per coordinate.** A fixture pins a dimension, and the arm that would have failed
   is the one never run.
3. **Write the prediction down first.** A read-back alone only confirms. A plausible wrong
   value passes unnoticed without a written prediction.
4. **A claim must match its measurement.** A write's *response* is not what it *wrote*.

### Step 4 — THEN: the UI and AAA

Only after Step 2. Three of the five layout asks are already half built, so this is smaller
than it sounds.

| # | Do this |
|---|---|
| 14 | **Decide whether the removed browser gates come back.** Four left the push hook on 16–17 September. **Decide this before any UI work**, or none of it will hold. |
| 15 | **Raise the contrast script to 7:1.** Derive its colour list from source instead of hand-writing it. Put it in the push hook. **Expect red. That red is your AAA baseline.** |
| 16 | **The six visible changes** (below). |
| 17 | **The interactive hover card.** It is a **design-system gap**. Add it to the DS, export it, document it, record it in `.claude/DS-GAPS.md`. Do not hand-roll it in the sheet. |

#### What you would actually SEE change

| You would see | Note |
|---|---|
| **Scope in a dropdown**, with the other scopes' readiness somewhere honest | Hard part: a chip shows every scope's readiness; a dropdown shows one |
| **Language in one dropdown with a count** | 🔴 Must stay multi-select. More than one language can be active today |
| **Filter chips folded into one "Filters" button** | Also fixes a measured clip: the toolbar takes **1345px of 1200px usable at 1280** and clips 9 controls |
| **One completeness column per scope**, with a popup that jumps to the missing field | Blocked until Step 2 lands |
| **Bullets in one cell** (the ten columns still available in Customise) | ⚠️ **Add** one cell. Do not replace the ten — four systems key off the slot names |
| **One pop-up editor**, one way of saying "Enter saves" | Today: **six** files say "Enter saves" |
| **Fewer columns on Shared**, with an honest reason where one is absent | |
| **Price read-only**, then writable through the one writer | |
| **"Delist" where "Unpublish (recommended)" is today** | |
| **A German label on a factual dropdown**, with your override still winning | |

**What would NOT change:** the sheet, the rows, the drawer, the grid gestures, the provenance
marks, the views menu, the formula editor, import and export. **That is most of the product,
and it stays.**

#### What AAA has to mean, so it can be checked

You said the sheet is "still not AAA quality". That is correct, and it is measurable.

Today: the contrast script tests **4.5:1, which is AA, not AAA**. It reads a **hand-written**
colour list. And it is **not in the push hook at all**. Known gaps already recorded: 5.91:1
and 6.51:1. Both pass AA. **Both fail AAA.**

AAA here means four countable things:

1. **Contrast 7:1** on every text pair the editors use, light and dark, with the colour list
   **derived from source**.
2. **One keyboard model**, proven by a gate, identical on Master, Amazon and eBay.
3. **Keyboard parity for every pointer action.** Anything you can drag, you can move with the
   keyboard, with a live announcement.
4. **No invented state.** No empty image box where images do not apply. No hint promising a
   gesture the editor does not own.

> **AAA is not a polish pass at the end. It is a gate that does not exist yet.**

🔴 And one honest warning: **you cannot ask for AAA and accept a shrinking gate set in the
same month.** Four browser gates were removed from the push hook on 16–17 September. Decide
whether they come back **before** any AAA work is scheduled, or it will not hold for a week.

---

## Part 9 — Decisions only you can make

If you rule on nothing else, rule on the first three.

| # | The decision | The recommendation |
|---|---|---|
| **1** | **What gets committed?** 11 production migrations untracked, 5 unowned | 🔴 **Settle this first of all.** It is the control problem under every fork. |
| **2** | **One price writer?** | ✅ **Yes.** `matrix-write.service.ts`. Retire `PATCH /channel-pricing`. Fix the Amazon sale-price wipe **before** any price write ships. |
| **3** | **What does the language dial mean at publish?** (a) sheet only · (b) the language of the content sent to this market · (c) changing language moves you to that market | ✅ **(b).** The only option that serves a two-language market like Belgium, and it makes the fix mechanical. |
| **4** | **What does the Shared scope show?** (a) the family's own fields · (b) the family plus **connected** channels · (c) today: any channel with a listing row anywhere in the workspace | ✅ **The family's own fields decide the columns; the channel decides the requirements.** Quick win today: one `where` clause. Needs an honest empty state when a connection drops, **not disappearing columns**. |
| **5** | **Factual attribute = a code plus a translated label, with a gate?** | ✅ **Yes**, starting with schema enums. **The cheapest item in this file.** The contract, the data and the ruling all already exist. Only a gate is missing. |
| **6** | **One authoritative writer for a child's size and colour?** | ✅ **Yes.** Three stores disagree today. It blocks all variation fidelity. |
| **7** | **A parity gate between the two payload builders?** | ✅ **Yes.** |
| **8** | **Do the removed browser gates come back?** | ✅ **Yes, and decide it BEFORE the UI track builds anything.** |
| **9** | **Raise contrast to 7:1, derive the colour list, put it in the hook?** | ✅ **Yes.** Expect red. That red is your baseline. |
| **10** | **Approve the readiness reconcile on production?** | ✅ **Yes.** Nothing readiness-shaped works until it runs. |

**Also blocking:**

| # | Why it blocks |
|---|---|
| Designate a development Shopify store | Nothing Shopify can be verified without one. |
| `Marketplace.languages`: primary only, or every published language? | Decision 3's fallback resolves against this. |

---

## Part 10 — What NOT to do

Each of these is tempting. Each is wrong right now.

| Do not | Why |
|---|---|
| ❌ **Add a writable price column to the sheet** | It doubles a live data-loss path on the money field. Fix the writer first. Then the column is trivial. |
| ❌ **Build the completeness column yet** | 0 attributes are required and production has 0 readiness rows. You would ship a column that reads "Not computed" on every row. |
| ❌ **Start AAA work while gates are being removed** | You cannot ask for AAA and accept a shrinking gate set in the same month. |
| ❌ **Add another tab** | There are eleven already. Every new one is a place the truth can fork. **That is exactly how the price bug happened.** |
| ❌ **Make it "smarter and more dynamic"** | Every clever path is a second place a rule can live. Least effort comes from **fewer** paths. |
| ❌ **Replace the ten bullet columns** | Four systems key off the slot names. **Add** one cell beside them. No migration needed. |
| ❌ **Scope columns by which channel is connected** | Then disconnecting a channel deletes columns from your catalog. Your data model would depend on an OAuth token. |
| ❌ **Redesign anything** | The sheet is right. The industry comparison confirms it. **This is repair and ordering, not redesign.** |

---

## Part 11 — What we have not measured

Be suspicious of this file. Here are its weakest parts, named honestly.

1. 🔴 **Nothing was run.** No payload was captured. No publish was fired. **Every claim about
   behaviour is read from source code.** A read-through is not a measurement.
2. 🔴 **"Your override reaches the payload" is a code trace, not an experiment.** It is the one
   claim most worth proving. Measurement **M1** settles it in one run.
3. 🔴 **"What the Shared scope shows" is inference.** Measurement **M4** settles it.
4. **694 plan items were never checked against the code.** Two whole topics are 100% unchecked.
   Treat all of them as unknown, not as done.
5. **The industry comparison is partly architectural knowledge, not fresh browsing.** The
   vendor-cited half comes from our own research of 2 September, which did read the vendor docs
   and tagged each claim. Salsify's help site refused every connection, so every Salsify line
   is a snippet at best.
6. **Etsy, WooCommerce and the image publish paths were not examined** in this pass.
7. **No live coordinate was exercised**, because eBay credentials fail to decrypt and Amazon
   returns `invalid_grant`.

**How to challenge this file.** Every claim above traces to a `file:line` in the source
documents listed in Part 12. Disagree with a fact, and it will be re-checked at that line.
The plan in Part 8 follows from the decisions in Part 9. Change a decision and the plan
changes with it.

---

## Part 12 — Where the details live

This file is a compilation. Nothing here is new research. Here is the source for each part.

| Source file | What it holds |
|---|---|
| `docs/product-sheet/RESEARCH-2026-09-21-RECOMPILED.md` | **The main source.** Every claim re-traced in code on 21–22 September. Parts A–L. |
| `docs/product-sheet/README.md` | The index of all 236 sources, topic by topic (01–16). |
| `docs/product-sheet/all-in-one/FUNCTIONALITY.md` | The eight fidelity defects, traced end to end. |
| `docs/product-sheet/all-in-one/RESEARCH.md` | The background archive. The 111-item decision register. |
| `docs/product-sheet/RESEARCH.md` · `PLAN.md` · `IMPLEMENTATION.md` | Short bullets: what was found, what was designed, what is built. |
| `docs/product-sheet/full/*-FULL.md` | Every source document, word for word. 7.8 MB. |
| `docs/2026-09-02-industry-research.md` | The vendor research. Akeneo, Plytix, Channable, Rithum, Shopify, Feedonomics. With source URLs. |
| `docs/2026-09-01-product-edit-studio-layout.md` | The original approved layout and its decision log. |
| `docs/2026-09-04-cell-editor-shell-design.md` | The one-editor design. Approved. Step 1 never started. |
| `docs/pes-claims.md` | The lane ledger. 5 MB. Rulings newest at the **top**. |

---

## Part 13 — What would actually change

Added 2026-09-22. The question: **if we do the plan, how does the product differ from today?**

### 13.0 — The big surprise

> **The screen barely changes. You are not getting a new app. You are getting the same app that
> stops lying to you.**

Think of a car. The plan does not change the seats or the steering wheel. It fixes the **brakes**,
the **fuel gauge** and the **speedometer** — the gauge that today reads "full" no matter what.

---

### 13.1 — What you would SEE change

Ten things. That is the whole list.

| # | Today | After |
|---|---|---|
| 1 | Lots of little **chips** for scope (Master, Amazon, eBay…) | **One dropdown** |
| 2 | Lots of little chips for language | **One dropdown with a count.** 🔴 Still multi-select — more than one language can be active today |
| 3 | Filter chips spill off the edge | Folded into **one "Filters" button** |
| 4 | No completeness column | **One completeness column.** Hover it: what is missing. Click it: it jumps there |
| 5 | Bullet points across **ten** columns | **One cell.** ⚠️ The ten stay available in Customise — four systems key off the slot names |
| 6 | **Two different** pop-up editors | **One** |
| 7 | **Six** different sentences say "Enter saves" | **One**, or none |
| 8 | Shared shows Amazon columns for a product that is not on Amazon | Only this product's real columns, **with a reason** where one is absent |
| 9 | The button says **"Unpublish (recommended)"** | The button says **"Delist"** |
| 10 | A dropdown shows `NERO` | It shows **`Schwarz`** on German. Your own override still wins |

**Two more you notice without being told:**
- The toolbar **stops clipping**. Measured today: it needs **1345.4px** and has **1200px** at 1280,
  so **9 controls** are cut off.
- Text gets easier to read. Contrast goes from **4.5:1 to 7:1**.

---

### 13.2 — What you could DO that you cannot today

This is the real change, and it is bigger than the UI change.

#### The dangerous ones

| Today | After |
|---|---|
| You press delete. 🔴 **No delist ever runs. Anywhere. On any channel.** The product leaves your screen and **stays live on Amazon** | Delist actually runs |
| You delete a product with a live listing. It vanishes locally, the adapter refuses, and **the listing stays live with no product row to manage it** | It **refuses**, naming the channel, the market and the listing id |
| "Unpublish" **deletes** on Amazon. You lose the ASIN link and the review history | **Pause the offer. Keep the ASIN. Keep the reviews.** Turn it back on later |
| Anyone with `products.edit` can **delete a live Amazon listing** | Needs its own permission |

#### The quiet ones — these cost money without telling you

| Today | After |
|---|---|
| You type a price in the sheet. 🔴 It **skips the push queue.** It may **never reach the channel at all** | One door, every time: event, audit row and enqueue |
| Two people edit price on two pages. **The careful page loses, silently** | One gets "saved". The other gets **"Changed elsewhere — reloaded"** |
| You pick German. The sheet shows German. 🔴 **The push sends Italian** | The push sends what you are looking at |
| You drag a cell down 100 rows. It writes values **you could not have typed** | It refuses them, with a reason per row |
| Every readiness chip on production says **"Not computed"** | Real numbers, that move when you empty a required field |
| "Ready 100%" is true for everything, because **0 of 198 attributes are required** | 100% means 100% |
| 🔴 **Nobody has ever checked what a channel actually holds. Not once. Ever** | **"We say €49.99. Amazon says €54.99. Checked 6 hours ago."** |

---

### 13.3 — What the scaling work adds on top

The scaling recommendations (Part 14, and Part 15 of `PLAN.md`) are **mostly invisible**. That is
the point.

> **They are not new buttons. They are the promise that none of the above breaks when the catalog
> is 10,000 products instead of 40.**

**Three you would see:**

| # | Change |
|---|---|
| 1 | Edit 5,000 rows and get **"4,987 saved · 13 refused · here is why"**, instead of one red error and no idea what happened |
| 2 | Same shape for a bulk delete: **"487 deleted · 13 refused — live on Amazon·IT"** |
| 3 | Drift appears **right after you publish**, not on a nightly sweep |

---

### 13.4 — What does NOT change

This matters, because it is most of the product.

The sheet. The rows. The drawer. The grid gestures. Copy, paste and the fill handle. The
provenance marks. The views menu. The formula editor. Import and export. The Matrix page. The
Variants page.

**All of it stays.** The plan says it plainly: *"Do not redesign anything. The sheet is right."*

---

### 13.5 — A day in your life, before and after

**Today.** You open a product. You pick German. You type a title and a price. The screen says
"Saved". The readiness chip says "Not computed".

Behind your back: the title went out **in Italian**. The price went into the database but **never
joined the queue**, so eBay may still show the old one. Nobody ever looked at what Amazon has.

You delete an old product and pick "Unpublish (recommended)". It disappears from your list. **It is
still selling on Amazon**, and you have no way to find it.

**After.** You open a product. You pick German. The completeness column says **"82% — missing:
GTIN, fabric type"**. You hover, you click, it jumps to the empty cell.

You type a title. It goes out in German. You type a price; somebody changed it two minutes ago, so
you get **"Changed elsewhere — reloaded"** instead of silently losing.

You delete the old product. It says: **"This is live on Amazon·IT, listing B08XYZ. Delist it first,
or disconnect it."**

Next morning: **"Amazon·DE — ours €49.99, theirs €54.99, checked 6 hours ago."**

---

### 13.6 — The honest bits

1. **None of it is built.** This is a plan. Nothing was run.
2. 🔴 **Two doors are locked.** eBay credentials fail to decrypt; Amazon returns `invalid_grant`.
   Until they are fixed, **drift and read-back cannot happen at all** — and that is 13.2's best
   item.
3. **The four measurements come first**, and they may change things. If the fidelity gap is large,
   mapping-rule coverage becomes the biggest job in the programme. Today rules exist for
   **Amazon IT/DE, OUTERWEAR only.**
4. **The completeness column is blocked** until somebody marks which attributes are required. That
   is a decision, not code.
5. **The UI is last on purpose.** So 13.1's list is the furthest away. 13.2 comes first.

> **The app looks almost the same. It stops silently doing the wrong thing, it starts telling you
> the truth about what is missing and what the channel really has — and the scaling work is what
> stops all of that falling over at a few hundred products.**

---

## Part 14 — What breaks at thousands of products

Added 2026-09-22. **The full version is [Part 15 of `PLAN.md`](PLAN.md#part-15--scaling-to-thousands-of-products).**
This is the short version, because it changes what "best in the industry" costs.

### 14.0 — The headline

> **The plan is good on correctness and silent on cost.**
> **Three of its steps break at around 500 products, not thousands.**

### 14.1 — The four that break

| # | What | The number |
|---|---|---|
| 1 | **The nightly readiness job** | The code records **4.087 s per family**. That is 68 min at 1,000 families and **11.4 hours at 10,000**, producing **~7.1 M rows** — and it multiplies again by the number of business profiles |
| 2 | **The drift table** | The plan says "one row per coordinate" but lists a `field` column, which makes it one row per coordinate **per field** — `ReadinessIndex` × ~150. **Hundreds of millions of rows** |
| 3 | **A cache that never lets go** | `WorkspaceCache` bounds workspaces at 64 but **not the entries inside one**. Its key includes the product, so every product opened stays in memory forever |
| 4 | **The Shared-scope query** | It is a **full-table aggregate with no `where` clause** — the biggest query in the sheet read path, and never timed |

### 14.2 — The fixes, in one line each

| # | Fix |
|---|---|
| 1 | **Split the backfill off the cron. Give the nightly job a time budget and a resume point. Only sweep what changed** |
| 2 | **One row per coordinate with a `driftCount`. Check after a publish, not on a sweep. Give drift its own queue** so it cannot starve publishes |
| 3 | **Bound the inner Map.** The file already shows the idiom one level up. ≈3 lines |
| 4 | **Add the `where`, and time it before and after** |

### 14.3 — The structural gap

Every step in the plan has a **Gate**. None had a **Cost**.

> **A rule with no gate stops being true. A budget with no number stops being affordable.**

Two additions, now in `PLAN.md`:
- **A `Cost when` field on every step**, beside `Done when`.
- 🔴 **One scale fixture** — a seeded workspace at **1,000 and 10,000 products**. Without it every
  cost number is a guess, and a sweep that passes on 37 families **has not been shown capable of
  failing**.

### 14.4 — Three places the approach is not the best

| # | Item | Recommendation |
|---|---|---|
| 1 | **"One lane at a time" has no end date** | Right now, wrong forever. **Name the exit:** ledger clean + all gates in the hook → back to short-lived branches. Keep "nothing merges without its gate" permanently |
| 2 | **D-G keeps two payload builders by default** | **Flip it to collapse.** The plan forbids a twelfth tab for exactly this reason; a second builder is the same thing |
| 3 | **A refused delete throws** | **Return per-row outcomes**, like the price writer already does. A bulk delete should report 487 done and 13 refused, not fail on row 14 |

---

## The whole thing in one paragraph

**Stop the parallel lanes and commit what exists.** Then spend a day stopping live damage:
price read-only, delist is not delete, fix the delist cascade. Then spend a week on the model:
mark the required attributes, one writer per field, pass the language to the publish, run the
readiness reconcile on production. Then prove it: fix the channel credentials, take the four
measurements, add the parity gate, and make the first live write-and-read-back this programme
has ever made. **Only then** do the UI — and bring the gates back before you start, or the
AAA work will not survive a week.

> **The sheet you built is the right sheet.
> What is missing is not features.
> It is a definition of "right", a single writer per field,
> and proof that what you see is what you send.**

---

## Your amendments

Write here. Nothing in this file is settled.

<!-- Owner: add your rulings, corrections and reordering below this line. -->
