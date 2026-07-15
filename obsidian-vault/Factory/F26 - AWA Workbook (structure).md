# F26 - AWA Workbook (structure)

> 🔒 **Privacy contract:** the workbook (`AWA 2026.xlsx`) is a **LOCAL-ONLY source**. Its *structure and workflow semantics* may be described in docs (this note, the EPF proposal); its **figures, amounts, and customer data never enter the repo, the vault, or any external service.** This is recorded in the [[F06 - Enterprise Program (EP)]] registry row for EPF.

Analyzed 2026-07-16 for [[F18 - Financials (EPF)]] (local Python only, no network).

## What it is

A **dual-entry reconciliation ledger between the factory and one B2B client** — the per-client-workbook pattern (one client account = one file). Every money concept exists twice: what the client states ("their calculation") and what the factory computes ("our calculation"), reconciled cell-by-cell with **EQUAL / NOT-EQUAL** flags at three grains: per order row (~600), per payment receipt (~110), and at the grand balance (with a prior-year opening balance hard-coded inside a formula).

## The workflow it encodes

Order arrives → append row (composite name cell encoding brand + order type + urgency + client's own ref + end-customer) → type the client's claimed total → copy the master rate-matrix formula for the factory total → the flag column turns red on any dispute → statuses overwritten in place (no history) → payments arrive **account-level** (unallocatable to orders) → balance chain computes what's owed → chase red cells by eye.

## Why it proves the EPF design

- ~590 hand-copied ~30-line IFS formulas across **two coexisting rate generations** (a mid-year contract change propagated only by copy-paste) + a latent column-drift bug + disagreeing duplicate totals + books that currently disagree at all three levels — textbook Panko spreadsheet-error classes, and the reason EPF.6 ships **no user formula language** (typed configuration only).
- The reconciliation columns are the workbook's raison d'être and exist in **no ERP we researched** → EPF.3's party ledger + two-sided reconciliation queue is the direct automation: opening balances, counterparty figures, EQUAL/NOT-EQUAL folds, payment→order allocation, printable statements.
- Concepts with no ERP home yet (client order ref, URGENT, remake links) route via [[F12 - Orders (EPO)]] grants (EPF D-9); the client's own rider-pipeline sheet is a possible future **brand portal** — its own registry row if ever pursued.

Full structure→ERP mapping table: `docs/factory/EPF-PROPOSAL.md` §4.
