---
name: review-and-undo
description: Tell the person what Claude did in their Nexus business ("what did you change yesterday?", "did my price change go through?") from claude-activity and approval-status, and, when they want it, ask to put one change or a whole change plan back with undo-change. Also covers undoing ad changes, Matrix listing changes, bulk jobs and imports made in Nexus. Use when the person asks what Claude changed, whether something ran, or to undo, revert or roll back a change.
---

# Review and undo

What Claude did is recorded in Nexus, call by call: what was read, what was asked for, and what became of each request. An undo is a NEW change request (the old values back), checked and approved like any other change.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. What happened

`claude-activity`, newest first. Filters: `from` / `to` (ISO times: "yesterday" = that day 00:00 to 24:00 in the person's time), `tool`, `outcome`, `connectionId`, `limit` (up to 100); follow `nextCursor` as `cursor` for older rows.

- Outcomes in words: `read`; `refused` (nothing was stored); `queued` (waits for a person); `auto` (ran by the business's rule); `approved` / `confirmed` (a person said yes in Nexus / with their code in Claude); `rejected`; `expired` (nobody decided); `superseded` (replaced by an edited request); `handed-back` (approved, then handed back without running); `failed`; `undone`.
- Group the answer by day and kind ("Tuesday: 3 price changes approved and run, 1 title change rejected"). Leave out plain reads unless asked.
- For one request in full: `approval-status` with its `approvalId` — `meaning`, the marketplace pushes it made (`channels`, `ads`, `ebay`, `publication`), each step of a plan, and `change.changeId` once it ran.
- Nexus pages: Settings › AI › Claude, tab **Activity**, shows the same list with an Undo button.

## 2. Can it be undone?

- `change.reversibility` (from `approval-status`): `full`, `partial` (some of it, say which) or `none`.
- Never undone: a message sent, a refund, a cancelled order, a confirmed shipment, a numbered invoice or credit note, a purchase order sent to a supplier, a carrier pickup, a new campaign (Nexus never deletes one). Say so; offer the nearest step (for example a correction message, or a new price).
- A change that reached a marketplace is undone by sending the old value again; the channel shows the new value until that push lands.

## 3. Ask for the undo

Show what goes back (from → to, how many, where it lands), ask, then:

- **A change or a plan Claude asked for:** `undo-change` with `business` and `changeId`, or the `approvalId` (a plan's `approvalId` puts back the whole plan, in reverse order). It picks the right opposite change itself.
  - Refused when the value changed again since (an undo would overwrite that), when an undo of it already waits, or when it cannot be undone. Pass the reason on; never force it with a fresh change unless the person asks for that new value.
- **An Amazon ad change made in Nexus by a person or a rule:** `undo-ad-change` with `changeSetId` (an approved ad request's id) or `actionLogId` (`undoActionLogId` from `ad-changes`), within 24 hours for a change set.
- **A stock or price change made on the Nexus Matrix page:** `revert-listing-change` with `productId` and the Matrix `operationId`, within 24 hours.
- **A bulk job or a catalog import:** `rollback-bulk-operation` with the `jobId` from `job-history` (kind `bulk` or `transfer`). Products and listings an import created stay.
- Several undos: ONE `submit-change-plan` with one step each (`undo-ad-change`, `revert-listing-change`, `rollback-bulk-operation` can be steps; `undo-change` is asked for on its own).

## 4. After

The undo is its own request: give its `approvalId` and the `approveAt` link, and follow it with `approval-status`. When it ran, `approval-status` on the ORIGINAL change shows `change.undoneAt`.
