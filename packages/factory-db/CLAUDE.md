# packages/factory-db — the factory's Prisma schema, migrations, policies and scoped client

Prisma 7.10 with a schema folder, `prisma/schema/`: `schema.prisma` holds the generator and the datasource, and each
module adds its own `<module>.prisma` (`_core.prisma`: Tenant, Company, Site, Line, WorkCentre, Station). The client is
generated into `src/generated/prisma` (git-ignored), never into `node_modules`, where Commerce's client lives.

## What it offers
- `@nexus/factory-db`: `openFactoryDatabase({ connectionString })` → `withScope(scope, client => …)`. One audited pg
  pool for the runtime login `factory_app` (db-kit's `AuditedPool`; the first connection is audited at open, so an
  unsafe login stops the boot), and one Prisma client per scope behind db-kit's `TenantPg`, kept in a cache (32, least
  recently used idle one closed). Scopes: `office` (tenantId, actorId), `floor` (+ siteId), `partner` (+ partyId),
  `platform` (none). Ids are UUIDs; a missing value throws before any query. Use a client only inside its callback.
  Also the model types and enums. Never the PrismaClient class.
- `@nexus/factory-db/testing`: `migratedDatabase(label)`, a throwaway database built from the migrations.
- `@nexus/factory-db/test-database`: the test-database guard.
- The walls (`src/roles.ts`, plan A1 §2.2): NOLOGIN roles `factory_runtime`, `factory_floor_runtime`,
  `factory_partner_runtime`, `factory_platform`; the login `factory_app` enters each WITH INHERIT FALSE, SET TRUE, so
  outside a role it reads nothing; only it may EXECUTE `set_config`. The migrations run as the owner login, never as
  `factory_app`; the migrations create `factory_app` without a password (Railway's is set once by hand).

## Commands
    cd packages/factory-db && npx prisma validate
    npm run generate -w @nexus/factory-db             # typecheck runs it first
    npm run typecheck -w @nexus/factory-db
    cd packages/factory-db && npx vitest run          # pure + real PostgreSQL (local stack), about 3 s
    node scripts/factory/run-pg-tests.mjs [filter]    # the PostgreSQL tests of every factory workspace
    node scripts/factory/check-ownership.mjs          # also in run-guards
    node scripts/factory/check-policy-parity.mjs      # also in run-guards
    node scripts/factory/check-migrations-replay.mjs  # = npm run check:drift -w @nexus/factory-db; needs the stack
    FACTORY_MIGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:5442/factory_<step> npm run migrate -w @nexus/factory-db
    FACTORY_DATABASE_URL=postgresql://factory_app@127.0.0.1:5442/factory_<step> npm run seed -w @nexus/factory-db

## A schema change
1. Edit your module's `prisma/schema/<module>.prisma` (conventions at the top of `_core.prisma`) and classify every new
   model in `ownership/<module>.json` (rules in `src/ownership.ts`).
2. `npm run migration -w @nexus/factory-db -- <YYYYMMDDHHmm>_<module>_<name>` (diff of the migrations, applied to a
   throwaway database, against the schema), then `npm run policies -w @nexus/factory-db -- <YYYYMMDDHHmm>_<module>_policies`
   (a later timestamp). Folder names: `<timestamp>_<module>_<name>`, so `_core` gives `…__core_…`.
3. Run the schema checks above and the PostgreSQL tests; the isolation tests cover a new table by themselves.
4. Merging (the lead, under the schema token, plan §2.1): merge `origin/main`, delete the branch's GENERATED migration
   folders, re-run step 2 with new timestamps, re-run the checks, merge, release the token. The hand-written folders
   (`…_audit_append_only`, `…_numbering_guards`, `…_outbox_guard`, `…_integration_guards`, `…_files_guards`,
   `…_links_guards`, `…_threads_guards`, `…_print_guards`, `…_parties_guards`, `…_email_guards`, `…_product_guards`,
   `…_email_in_guards`, `…_sales_guards`, `…_supply_guards`, `…_production_guards`, `…_quality_shipping_guards`,
   `…_money_guards`, `…_costing_guards`, `…_money_sdi_archive_guards`, `…_sales_settings_guards`,
   `…_inventory_issue_work_order_guards`, `…_company_bank_details_guards`, `…_privacy_guards` (it also redefines
   production's `factory_production_check_subject`), `…_quality_lab_guards` (it also redefines the register's
   `factory_ppe_register_entry_guard`: source type LabResult), `…_supply_po_proposals_guards` (it redefines the two
   purchase order functions of `…_supply_guards`), `…_production_scan_records_guards`, `…_numbering_floor_guards`,
   `…_production_garment_labels_guards` (it redefines the quality step's `factory_style_garment_tracking_guard`),
   `…_quality_final_release_guards` (it redefines the quality step's maker, inspection, release, reversal and serial
   functions), `…_production_leftovers_guards` (it redefines production's `factory_production_settings_guard` and
   `factory_bundle_guard` and supply's `factory_hide_guard`), `…_numbering_floor_documents_guards` (the floor's series and
   numbers; Inspection/QualityRelease numbers given once), `…_floor_sync_guards` (the floor sync's ledger append-only,
   refused actions closed once), `…_insights_attention_actions_guards` (Today's actions: the history append-only, a
   resolution needs its note, every action in its history at commit), `…_platform_w2a_guards` (W2a wave 1/7: calendars,
   notifications, tasks, views, exports, alerts, timers, reasons, search, drills; it redefines files'
   `factory_stored_file_guard` (the virus scan) and the three Today functions of `…_insights_attention_actions_guards`
   (the snooze)), `…_sales_w2a_guards` (W2a wave 2/7: terms, price lists, amendments, schedules, returns, repairs,
   complaints; it redefines sales' `factory_sales_order_line_guard` (closing short), the sales settings'
   `factory_sales_settings_guard` (return policy) and the register's `factory_ppe_register_entry_guard` (source type
   Complaint)), `…_supply_w2a_guards` (W2a wave 3/7: PO revisions and reminders append-only, claims, discrepancies,
   subcontract orders, type-change reviews; it redefines the two purchase order functions of
   `…_supply_po_proposals_guards`), `…_stock_plan_w2a_guards` (W2a wave 4/7: reservations, counts and their history,
   item parameters, settings, capacity, pegging append-only, exceptions; it redefines supply's
   `factory_material_requirement_guard` (the firm planned order)), `…_production_w2a_guards` (W2a wave 5/7: the work-order gate and hold, repair kind,
   line, bundle split, finished goods and production receipts, rework, replacements, plan versions and slots; it
   redefines production's `factory_work_order_guard` and `factory_work_order_size_guard` and wave 4's
   `factory_reservation_guard` (a held work order's reservations stay open)), `…_quality_plant_w2a_guards` (W2a wave 6/7:
   the defect library, disposition codes, holds and what they block (issue, cut, scan, release, packing, shipping), NCRs,
   machines and the unsafe lock, maintenance, freight; it redefines shipping's `factory_shipment_guard` (freight,
   transport evidence) and `factory_ddt_check` (a DDT for another reason) and the register's
   `factory_ppe_register_entry_guard` (source type Nonconformance)), `…_money_w2a_guards` (W2a wave 7/7: refunds, reminders, supplier invoices and their match, standard costs, the cost ledger append-only, accounting exports, period locks; it redefines money's `factory_invoice_check_issue`, `factory_invoice_line_guard`, `factory_payment_guard` and `factory_payment_allocation_check`, and adds its own period-lock triggers on Invoice, Payment and StockMove and the method lock on CostingSettings), `…_sales_advance_invoice_guards` (B-W2a-F2, no schema folder of its own: it redefines
   the wave-2 `factory_sales_order_milestone_guard` so a BEFORE_SHIPPING step may name its own deposit request too), `…_followups_stock_w2b_guards` (W2b wave 1/7, B-W2b-01: move reasons CUSTOMER_RETURN / SUPPLIER_RETURN / SHIPMENT and reason codes, hides coming back from SCRAPPED or RETURNED, the system release of a reservation, the posted receipt's DDT correction, claim and discrepancy reason codes, the claim line's replacement DDT, freight cost and transport mode, generated documents and subcontract receipts append-only, subcontract bundles, the outside operation's scan, scrap reason words, the split reason, work-order kits; it redefines supply's `factory_stock_move_check` and `factory_goods_receipt_guard`, the leftovers' `factory_hide_guard`, wave 5's `factory_reservation_guard`, wave 3's `factory_supplier_claim_line_guard`, wave 6's `factory_shipment_guard` and production's `factory_operation_scan_check`, `…_followups_quality_money_w2b_guards` (W2b wave 2/7: certificate renewals, purchasing and payables settings, files of several supplier invoices, the SDI inbox, interest reference rates, the live-number and one-delivery partial uniques of SupplierInvoice, the deferred `PaymentAllocation_carry_due`; it redefines numbering's two floor document functions (HOLD, NCR), `factory_material_requirement_guard` (a carried firm line made planned again), `factory_work_order_cost_entry_check` (scrap of a hand-opened rework), `factory_supplier_invoice_guard` (lotto, claim), `factory_payment_allocation_check` (a NONE deposit carried onto the invoice) and `factory_refund_guard` (the reason), `…_followups_platform_w2b_guards` (W2b wave 3/7: dated customer price lists, first-load steps written once, report runs never changed, a lifted suppression and one block in force per address, the personal default view, Style's copied-from, Role.requireMfaSince kept by the database, a supplier calendar's time zone; it makes ExportJob's view key ON DELETE SET NULL ("viewId") and redefines wave 1's `factory_export_job_guard` (the cleared view) and wave 2's `factory_sales_order_line_guard` (the closed-short reason code), `…_people_w2b_guards` (W2b wave 4/7: employees, teams and loans, leaver cases and steps, people settings, the legal gate per site and purpose, skills, levels and machine authorisations; its own triggers on Line (the area) and Worker / Employee (one office account per person); no W0-W2a function redefined), `…_time_w2b_guards` (W2b wave 5/7: roster,
   overtime asks and answers, clock events append-only, attendance days and anomalies, absences, overtime entries,
   timesheets, the month close that nothing is written into once closed, corrections append-only, working-time limits;
   it redefines no earlier function), `…_pay_w2b_guards` (W2b wave 6/7: piece pay and the payroll export; its own functions
   only, no earlier body redefined; it calls money's `factory_money_rome_day`), `…_floor_work_w2b_guards` (W2b wave
   7/7: operation timing, team members and ticked steps append-only, off-standard time and line days, LabourEdit
   append-only, disputes, dispatch, coupons, scan findings, crews, device modes, help calls, targets, handover notes;
   it redefines production's `factory_work_order_guard` (rush, split) and pay's `factory_earnings_entry_check` and
   `factory_held_scan_guard` (PARTIAL and HAND_BACK pay and hold their pieces), and recreates the OperationScan
   triggers `OperationScan_check`, `OperationScan_awaits_hold` and `OperationScan_awaits_quality_hold` with WHEN
   clauses, their functions untouched), `…_followups_people_pay_w2b1_guards` (W2b schema wave 9/16, B-W2b-75: the standard review limits, the printer of statements and the labour consultant in the people settings, a layout's confirmation, the payroll code, EarningsKind BONUS inside the legal switch's window; it redefines people's `factory_people_settings_guard`, pay's `factory_payroll_export_layout_guard` and wave 7's `factory_earnings_entry_check`), `…_followups_f1_w2b_guards` (B-W2b-F1: a new hold comes numbered;
   Shipment.carrierReturnReceivedAt set once while RETURNED, then the release cap no longer counts that shipment and its
   SHIPPED serials may go back to RELEASED; the RMA as a PPE register source; it redefines wave 2's
   `factory_quality_hold_number_guard`, wave 1's `factory_shipment_guard`, shipping's `factory_shipment_line_guard`, the
   final release's `factory_garment_serial_guard` and wave 6's `factory_ppe_register_entry_guard`, and fills the new
   column for carrier returns received before it),
   `…_followups_floor_w2b_guards` (W2b wave 8/16, B-W2b-74: COUPON a scan-id
   kind, unplanned operations and the parallel group's frozen copy, a floor session's decision of a correction, scrap
   approvals, the work order of an off-standard block, what a material call asks, an unplanned operation's piece rate; it
   redefines numbering's `factory_number_series_document_kind` and `factory_number_block_guard`, production's
   `factory_work_order_operation_guard` and the scan records' `factory_scan_correction_request_guard`, and recreates
   `OffStandardEntry_edit_recorded` with the work order among its facts),
   `…_inspection_plans_w2b_guards` (W2b wave 10/16: plans and versions (a second person approves, then frozen with their
   checks), AQL profiles (critical locked at 0) and assignments, the rules that open an inspection, incoming inspections with
   hides, rolls and components, in-process checks, results, measurements, amendments append-only; no W1 inspection or release
   function is redefined: it adds its own triggers `Inspection_plan_guard` and `OperationScan_awaits_first_piece`, and
   redefines numbering's two floor document functions (INCOMING_INSPECTION)),
   `…_quality_problems_w2b_guards` (W2b wave 11/16, B-W2b-79: CAPA and 8D with sources and actions, cause codes, a defect
   charged to its operation, NCR cost lines and concessions, hold groups, the bench settings and the four-eyes list, alert
   rules, the complaint's investigation and letter, a document of a record with no site; it redefines wave 6's
   `factory_nonconformance_guard`, the final release's `factory_quality_release_check` and wave 1's
   `factory_generated_document_check`, which waves 14 and 15 extend with their record tables),
   `…_leather_stock_w2b_guards` (W2b wave 12/16: leather grades and article rules, shade groups, hide marks, hide measures
   append-only, remnants, fabric rolls, protector lots, consumables by pack, ROLL and REMNANT as scan-id kinds, the move reason
   REMNANT as RETURN's twin; it redefines numbering's `factory_number_series_document_kind` and `factory_number_block_guard`,
   wave 1's `factory_stock_move_check` and `factory_hide_guard`, production's `factory_cut_log_check` and wave 2's
   `factory_work_order_cost_entry_check`, and recreates the trigger `StockMove_bound_to_work_order` with REMNANT in its WHEN),
   `…_cutting_room_w2b_guards` (W2b wave 13/16: cut orders and lines, cut and recut tickets (one per lay, one per leather cut order:
   partial uniques), lays with the ply check at both ends, lay rolls of one shade, ply runs, the reconciliation append-only, the
   consumption, secondary processes, trolleys to sewing, pattern pieces frozen with their revision (it reuses the product part rule),
   second quality; its own trigger `CutLog_cutting_rules` (photo, thickness, overrides) and no cut log function touched; it redefines
   wave 5's `factory_rework_order_guard` (the repair station's scans) and `factory_replacement_request_guard` (the recut ticket)),
   `…_plant_care_w2b_guards` (W2b wave 14/16: check types, plans (one active per machine and type: a partial unique) and results
   append-only (corrected once: a partial unique), the machine status history append-only, written by its own trigger
   `Machine_status_history` on every status change, clicking dies, the site's plant rules held at Owner answer H1, routing rules;
   its own trigger `StoredFile_floor_guard` (the floor adds and confirms only the photos and voice notes of a request or job); it
   redefines wave 6's `factory_maintenance_request_guard` (progress, routing, escalation) and `factory_maintenance_job_guard`
   (failure code, minutes, the lead's confirmation, the check result) and wave 11's `factory_generated_document_check` (CHECK_REPORT
   of its MachineCheckResult)),
   `…_safety_w2b_guards` (W2b wave 15/16: the safety organisation and the RLS notice, typed deadlines (one next per occurrence: a
   partial unique), DVR versions frozen until signed, their signatures append-only (one per role: a key), measures, role sheets with
   their risks, kits and courses, the course catalogue, sessions, attendance (one per person: a key) signed with the PIN only by a
   floor session, training records append-only (corrected once, one per attendance: partial uniques), the instruction register,
   PPE items and PPE issues append-only (voided once by a VOID row: a partial unique); its own trigger `Employee_role_sheet_check`
   (Employee's guard untouched); it redefines wave 14's `factory_generated_document_check` (DVR_FROZEN of its
   RiskAssessmentVersion, PPE_RECEIPT of its PpeIssue)),
   `…_protected_safety_w2b_guards` (W2b wave 16/16, protected safety data: health plans (one per role: a key), visits, fitness
   judgements (outcome and task limits only, voided once, one live per visit: a partial unique), the view log ProtectedView
   append-only, incidents (numbered from the floor's INCIDENT series; a nameless report holds no reporter, creator or tablet;
   closing held while an action or a filing waits), the people involved (the floor inserts, never reads), actions, INAIL filings
   (48 hours from the certificate; one per person and type: a key), chemicals and data sheets (one current per language: a
   partial unique); its own triggers `StoredFile_protected_office_only` and `SearchEntry_not_protected`; it redefines wave 10's
   numbering floor functions `factory_number_series_floor_guard` and `factory_number_allocation_floor_guard` (INCIDENT)),
   `…_portal_identity_w2b_guards` (W2b schema wave 17/22, B-W2b-152: a person's audience (a partner user has one party
   and a fitting kind, never a password; a guest's access ends), sessions bound to their person's party (30 minutes idle,
   12 hours at most; office previews), partner invitations, a partner role at most the price grain and its assignments
   bound to the person's party, sign-in codes (15 minutes, 5 tries, hashes only, one live per person and purpose: a partial
   unique; dead codes never open again), portal settings, company branding, the portal terms' acknowledgements append-only;
   its own triggers on User, Session, Invitation, Role and RoleAssignment, no earlier function redefined),
   `…_files_depth_w2b_guards` (W2b wave 18/22, files in depth: versions numbered in their series, one new version at a time and
   one current at commit (deferred), a superseded version read-only, copies with their source's bytes, the expiry reminder, the
   thumbnail once, upload sessions in parts, markups append-only, one active required-document rule per key (partial uniques);
   it redefines W2a's `factory_stored_file_guard`),
   `…_links_depth_w2b_guards` (W2b wave 19/22, links in depth: a link's password as a scrypt hash only (DOCUMENT_VIEW, SECURE_FILE),
   five wrong passwords hold it up to 15 minutes, the receipt once (SECURE_FILE), a renewal of the same record and purpose; a link's
   files added while it is unused, never changed; drafts sealed, only for a long form and only while the link opens; record shares
   (VIEW always, 180 days at most, the party switches its e-mail only); approval requests answered once by the party; no link, file
   set, share or approval of a pay record (`factory_link_pay_record`); it redefines W0's `factory_guard_link_change` and wave 11's
   `factory_ncr_concession_guard` (the customer writes the answer columns only, after its approval request's answer)),
   `…_portal_sales_w2b_guards` (W2b wave 21/22, the customer portal: order requests kept as the customer's DRAFT, sent with
   their number and pieces, decided by the office (one order or quote, words to refuse) or withdrawn, their lines only while
   DRAFT; change and cancel requests of an order still open to amendments (a cancel's reason code), answered by the office,
   withdrawn by the customer, an accepted one naming its amendment once, their cells written once; payment intents moved
   forward only, no card number in any column (`factory_payment_provider_text_ok`), a succeeded one naming its payment once;
   its own triggers on MeasurementProfile (a link session adds the revision sent through its MEASUREMENTS link; only the
   photos' deletion date moves) and SalesSettings (the cut-off rules); no earlier function redefined): triggers, partial unique indexes and deferred
   constraint triggers) are not regenerated: `git mv` the branch's one, unchanged, to a timestamp between its new schema and policy folders; keep it
   out of `prisma/migrations` while `npm run migration` runs (it replays every folder, and the triggers need the new
   table). `…_platform_w2a_extensions` (`CREATE EXTENSION pg_trgm`, for SearchEntry's trigram index) is hand-written
   too but goes the other way: keep it IN `prisma/migrations`, under a timestamp before its schema folder, while
   `npm run migration` runs (the generated index needs the extension). A guards folder with no schema folder of its own (…_inventory_issue_work_order_guards) still gets a policy
   folder after it (the generator's output again): the policy folder is always the last migration.

## Rules
- Run the Prisma CLI only from this folder. `prisma.config.ts` reads only `packages/factory-db/.env`
  (`FACTORY_MIGRATION_DATABASE_URL`, else `FACTORY_DATABASE_URL`; the process environment wins) and refuses a
  non-loopback database off Railway. `prisma migrate diff` needs a datasource even with `--from-empty`.
- Every model is classified (`check-ownership`): kind `tenant` (a `tenantId` column with the standard default, which
  the app never sets) or `platform`. An unclassified model gets no grant and no policy.
- The policies are generated, never hand-written: each policy migration holds the whole generated SQL, and the newest
  one must be the last migration and equal the generator (`check-policy-parity`).
- The history replays from zero, unlike Commerce (`check-migrations-replay`). Never `prisma migrate reset`,
  `prisma db push` or `prisma migrate dev` against a shared database.
- References inside a tenant include `tenantId` (and `siteId` between rows of one site): foreign-key checks skip
  row-level security, these keys do not let a row point at another tenant's row.
- The roles are cluster-wide and shared by every worktree on the local server: tests never drop or alter them; a test
  role gets a random name and is dropped. Migrations take the advisory lock in `src/testing/database.ts`.
- Seeds (`seed/<module>.ts`, run in name order) hold made-up data only and write through the scoped client.
- Every generator has an `output` inside this package (`check-prisma-output`). No `Float` (`check-no-float`): amounts
  are Int minor units, unit prices and costs Decimal(18,6), quantities Decimal(18,4).
- Never hand-edit `src/generated/` or a policy migration.
