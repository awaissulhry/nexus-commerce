# FBA shipments page — plan (Owner 2026-10-08, PLAN ONLY — build after the Owner's yes)

The Owner asked: one page for FBA shipments. "Send to FBA" on the Matrix makes a DRAFT there (the units and cases
chosen); the Matrix shows a link when a draft is pending or a shipment is planned but not finished. Plan first, then
release after his approval.

## What exists (research 2026-10-08)
- Send to FBA works from the Matrix only, one product family at a time (a UI limit: the server takes any SKUs, up to 200).
- "Create plan" at once holds the units (FBA_SEND, 45 days, never expires by itself) and starts Amazon's steps.
- The plans list lives in a Matrix drawer and shows only that family's plans. GET /api/fba/inbound/plans can list all
  plans of the business, but it has no paging (50 max) and no status filter.
- The Inbound page's "Send to Amazon FBA" button and the old page /fulfillment/inbound/v2 are DEAD: their server routes
  answer 410 (retired in Step 4); the button shows "Plan failed". Matrix plans do not show on the Inbound page.
- Fulfillment menu: Stock · Inbound · Outbound (customer orders) · Replenishment (restock signals, incl. FBA) · POs · …
- The plan table's `status` column defaults to 'DRAFT' for OLD wizard rows (source null). Every new reader filters
  `source`, so a new draft is `status = 'DRAFT'` WITH a source — never confused with the old rows.

## The flow
1. Matrix → tick SKUs → "Send to FBA…" → the same dialog (From, To, Ready, Cases per size, Units). Its button becomes
   **"Add to draft · N units"**. No Amazon call, no hold. The SKUs go into the open draft for that From + To (made if
   none). A SKU already in the draft gets the new numbers (the dialog starts from them). Toast: "Added to draft · Open".
2. Matrix footer link: **"FBA draft · 18 units"** when a draft holds this family's SKUs, **"FBA shipment · Ready to ship"**
   (or its status) when one is under way. It opens the page at that shipment.
3. The page **FBA shipments**: tabs Drafts · In progress · Done. One list for every product family.
   - A draft: From, To, Ready, the SAME SKU table as the dialog (Free, Cases per size, Units, Boxes, Check, live free
     numbers), "Add SKUs" (search any product), remove a SKU, Prep by / Labels by when not set.
     Buttons: **"Send to Amazon · N units"** (= today's Create plan: checks, holds the units, Amazon's steps) and
     "Delete draft".
   - Under way: today's plan view (timeline, pick where it goes + Confirm, labels, tracking, Mark shipped, Cancel).
   - Live: every change publishes `fba.plan_changed`; the page and the Matrix re-read.
4. Claude's plan tool makes or fills a draft too; a person sends it from the page.

## Build (after the yes)
- **API:** status DRAFT (never claimed by the runner; "open"; its own actions: edit, delete, send). Routes: add to the
  open draft, edit a draft, delete a draft, send a draft (today's create path), list plans with a status filter and
  paging. Draft lines keep only the SKU, cases per size and loose units; the Amazon SKU and owners are read again at
  Send (migration 20261008w is unreleased: make `msku`, `prepOwner`, `labelOwner` nullable in place). Matrix read: the
  family's draft. Claude's tool → draft. Tests incl. a real-Postgres race: a double "Send to Amazon" makes one plan.
- **Web:** the page + menu entry + command palette; the dialog's SKU table and the plan view become ONE shared
  component each (the dialog, the page draft and the page plan view use them); the Matrix footer link; the Matrix drawer
  goes (the page is the one place). The dead Inbound button and the dead /fulfillment/inbound/v2 page point to the new
  page (old modal deleted).
- **Checks:** typecheck of every changed workspace, the area tests, the guards, a browser check light/dark 1440/390.
- **Release:** together with Steps 1–4, the case sizes and this page, after the Owner's yes.

## Owner decisions (2026-10-08)
- D1 Where: **Fulfillment › Outbound › "FBA shipments"** (`/fulfillment/outbound/fba`) — the Owner keeps Inbound for
  shipments from suppliers.
- D2 Matrix "Send to FBA": **add to the ONE open draft for that From + To**.
- D3 Hold the units: **at "Send to Amazon"** (a draft never blocks a sale).
- D4 The Matrix drawer: **kept** (it shows the family's drafts too, with a link to the page); the footer link opens the
  page. The drawer and the page share ONE plan view component.
- The dead Inbound "Send to Amazon FBA" button: the Owner said it need not be linked. But our release retires its
  routes, so it must not stay a dead button: it opens the new page; /fulfillment/inbound/v2 redirects there; the dead
  modal is deleted.

## Contract (done, lead)
`packages/shared/fba-send.ts`: status DRAFT (first; a person status; never claimed; never cancellable), `isFbaPlanUnderWay`,
`fbaPlanCan` → `edit` / `send` / `discard`, `FbaSendDraft.draftId` + `.lines`, `FbaDraftAddRequest`,
`FbaDraftUpdateRequest`, `FbaDraftSendRequest`, `FBA_PLAN_VIEWS` / `fbaPlanViewOf`, `FbaPlanListAnswer`,
`FbaPlanLineView.msku / prepOwner / labelOwner` nullable, words (`addToDraft`, `sendToAmazon`, `deleteDraft`, `newDraft`,
`addSkus`, `removeSku`, `draftExists`, `pageTitle`, `views`, `openPage`, `draftLink`, `shipmentLink`, `status.DRAFT`).
Migration 20261008w (unreleased) rewritten in place: FbaInboundPlanLine `msku`, `prepOwner`, `labelOwner` nullable
(private DBs altered by hand + checksum).
