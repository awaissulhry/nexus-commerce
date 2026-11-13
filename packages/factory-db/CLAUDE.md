# packages/factory-db — the factory's Prisma schema, migrations, policies and scoped client

Prisma 7.10 with a schema folder, `prisma/schema/`: `schema.prisma` holds the generator and the datasource, and each
module adds its own `<module>.prisma` (`_core.prisma`: Tenant, Company, Site, Line, WorkCentre, Station). The client is
generated into `src/generated/prisma` (git-ignored), never into `node_modules`, where Commerce's client lives.

## What it offers
- `@nexus/factory-db`: `openFactoryDatabase({ connectionString })` → `withScope(scope, client => …)`. One audited pg
  pool for the runtime login `factory_app` (db-kit's `AuditedPool`; the first connection is audited at open, so an
  unsafe login stops the boot), and one Prisma client per scope behind db-kit's `TenantPg`, kept in a cache
  (`clientCapacity`, default 16, least recently used idle one closed). Scopes: `office` (tenantId, actorId), `floor`
  (+ siteId), `partner` (+ partyId), `platform` (none). Ids are UUIDs; a missing value throws before any query. Use a
  client only inside its callback. Also the model types and enums. Never the PrismaClient class.
- The client cache and memory (B-W2b-F9): a Prisma 7.10 client takes about 86 MB of heap and 95 ms the moment it is
  made (its engine decodes the generated parameterization graph into objects of its own; Prisma offers no supported
  way to share them) and 10-25 MB of query-compiler memory at its first query. So a client is chosen by the role and
  the settings the walls read (tenant; site; party), never by the actor: the actor is required in every office, floor
  and partner scope but is not a database setting, and every actor of a tenant, site or party shares one client.
  `client.vitest.test.ts` fails when a migration reads a setting no scope sets (a guard on `factory.actor_id` would
  put the actor back into `SCOPE_DEFINITIONS` and the cache back to one client per person) and when one more client
  costs more than 130 MB of heap.
- `@nexus/factory-db/testing`: `migratedDatabase(label)`, a throwaway database copied from `factory_tpl_<hash of the migrations>` (B-W2b-F27, `src/testing/template.ts`: built once per migration set under the lock, then `CREATE DATABASE … TEMPLATE` without it); `FACTORY_PG_TEST_TEMPLATE=off` migrates each one from zero instead.
- The test migration lock (B-W2b-F11, `src/testing/migration-lock.ts`): builds of test databases on one server take
  turns under `MIGRATION_LOCK`, now a transaction-level advisory lock on a connection of its own that is closed when the
  build ends. A killed process frees it at once; one that stops acting (frozen, stalled, a lost socket) stops its
  `SELECT 1` heartbeat, and the server ends its session after 60 s idle (`idle_in_transaction_session_timeout`); a
  build that holds it over 5 min gives it back and fails. A waiter waits 5 s at a time and reads the holder from
  `pg_locks` and `pg_stat_activity`; a holder idle for 3 min, or 15 min of waiting, ends the wait with a
  `MigrationLockError` that names it (pid, application_name, state, idle time, last query). The kit never ends anyone
  else's session. Every kit connection is named `factory-test <lock|root|admin> <client pid> <database>`, so a holder can
  be traced to its process (Docker hides the client port). `check-migrations-replay` takes the same lock (B-W2b-F15:
  `withMigrationLock`, `prisma migrate deploy` as an asynchronous child the lost lock kills; its connections named
  `factory-test <lock|root|admin> <pid> replay_<hex>`); an older worktree's copy may still take the old session-level lock on
  the same key, and the two exclude each other. A Mac that sleeps freezes every holder and the server alike, and on
  waking the server counts the sleep as idle time (11-07's 600 s "stuck" holder matched a 596 s sleep): a build caught
  by a sleep may lose the lock and fail with a clear message; run it again.
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
   clauses, their functions untouched), `…_followups_people_pay_w2b1_guards` (W2b schema wave 9/16, B-W2b-75: the standard review limits, the printer of statements and the labour consultant in the people settings, a layout's confirmation, the payroll code, EarningsKind BONUS inside the legal switch's window; it redefines people's `factory_people_settings_guard`, pay's `factory_payroll_export_layout_guard` and wave 7's `factory_earnings_entry_check`), `…_followups_people_pay_w2b1_copy` (B-W2b-89, data only: moves the CARRIED row of an export's checks into `correctionsCarried` with `PayrollExport_guard` off for that one statement, a layout's `definition.confirmation` into its columns and `definition.companyCode` into Company.payrollCode; a regenerated policy migration follows it), `…_followups_f1_w2b_guards` (B-W2b-F1: a new hold comes numbered;
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
   `…_portal_frame_w2b_guards` (W2b wave 20/22, the portal frame: partner tasks born OPEN, closed exactly with a time, done by an
   active person of their party, a partner session only closes an open one as DONE, reopened by the office, never deleted;
   e-mail settings of a partner user of the row's party, only the frequency changes; a partner user's notification carries
   the person's party, an office person's none (`Notification_party_check`); what a portal session posts (`Message_partner_post`:
   INBOUND, PARTNER, PORTAL, PARTY, the person's name, files of the record shared with its party); it redefines W2a's
   `factory_notification_delivery_check` (EMAIL_DIGEST names its mail), `…_portal_sales_w2b_guards` (W2b wave 21/22, the customer portal: order requests kept as the customer's DRAFT, sent with their number and pieces, decided by the office (one order or quote, words to refuse) or withdrawn, their lines only while DRAFT; change and cancel requests of an order still open to amendments (a cancel's reason code), answered by the office, withdrawn by the customer, an accepted one naming its amendment once, their cells written once; payment intents moved forward only, no card number in any column (`factory_payment_provider_text_ok`), a succeeded one naming its payment once; its own triggers on MeasurementProfile (a link session adds the revision sent through its MEASUREMENTS link; only the photos' deletion date moves) and SalesSettings (the cut-off rules); no earlier function redefined, `…_portal_supply_w2b_guards` (W2b wave 22/22, the supplier portal: ship notices DRAFT → SENT (numbered by the office) → RECEIVED (a posted receipt names it), lines and the packing list per hide while DRAFT or SENT, a goods receipt's ship notice of its own order; progress reports append-only; return notices announced once, then received or cancelled; questionnaire versions fixed once published, answers reviewed once; the kit line's check by the workshop once while SENT; it redefines W2a's `factory_purchase_order_line_guard` (the substitute and the buyer's-yes flag in the proposal) and `factory_subcontract_order_guard` (the workshop's answer and the office's answer to its date; cleared back to DRAFT; a partner session answers only)),
   `…_portal_followups_w2b_guards` (W2b schema wave 23, B-W2b-F12, the portal steps' follow-ups: a PORTAL purchase order
   confirmation with its person and a proposal by a portal person instead of a link (exactly one), accepted as a PORTAL
   confirmation by the same person; a delivery address a partner session adds that WAITS for the office's check (decided
   once, a refusal archived) and that no quote version or shipment names meanwhile; supplier document uploads and party
   change requests (decided once, the request's version moves by one, a partner session only withdraws); a return's
   channel, wish and words fixed at insert (a portal or link request starts REQUESTED); a LINK DVR signature names an
   APPROVED approval request of its version for the appointment of the request's party, and no other safety register is
   signed LINK; a partner task's assignee, a parcel's https tracking page, the cancel fee, a party's website; it redefines
   W2a's `factory_purchase_order_guard`, F1's `factory_shipment_guard` (the carrier's ETA after the goods left) and wave
   15's `factory_risk_assessment_signature_check`),
   `…_followups_quality_cutting_w2b2_guards` (W2b schema wave 24/33, B-W2b-204, the W2b-2 quality and cutting follow-ups:
   the inspected count up to the sample on the three inspection records (a counted unit freezes the AQL profile) and the
   in-process check's own sample; the rule that opened a record (given at insert by the office, never changed, of an event
   of that kind of record, on the rule's plan; a rule that opened records is not deleted: Restrict); a rule's due hours and
   the in-process check's due time (never the floor's); the site's cutting rules, the leather area tolerance, the tenant's
   severity words (tenant-wide row only; CRITICAL's meaning locked); a downgrade's second-quality move named once; it
   redefines W1's `factory_inspection_guard` (a rule-opened inspection waits for its inspector while OPEN or CANCELLED) and
   wave 13's `factory_replacement_request_guard` (a RECUT DONE by its DONE recut ticket; a VOID ticket replaced while OPEN)
   and `factory_garment_downgrade_guard` (moveId set once), `…_routings_instructions_w2b_guards` (W2b-4 schema wave 25/33, B-W2b-205: an operation's and a routing step's minutes from basic minutes and allowances, an approved SMV version as the only way to change a governed operation's SMV, SMV versions proposed and decided once by a second person, a routing step's checkpoint, cells and set-up/wait/move minutes, per-size times and machine settings as parts of the revision (W1's `factory_style_revision_part_guard` as it is), a revision's effective days, work instructions (one ACTIVE per operation and revision: partial uniques) with versions published by a second person and frozen (one PUBLISHED per instruction: a partial unique), steps and media only while DRAFT carrying their version's status (ON UPDATE CASCADE), acknowledgements append-only; it redefines W1's `factory_style_revision_guard`: a released revision freezes every column but its status and effectiveTo, a later one too, `…_styles_libraries_w2b_guards` (W2b schema wave 26/33, B-W2b-206, styles and libraries in depth; it first fills the rows made before it: a style's lifecycle from its record state and revisions, a material of a released BOM APPROVED by its first release; then: a style's lifecycle moves with its time, into IN_PRODUCTION only with a RELEASED revision, its replacement only while PHASE_OUT or DISCONTINUED, its product type of its kind and company, sold under our name only with a brand; a SKU's GTIN in its shortest form with its check digit, fixed once garments with it shipped; a colour's system and reference; a material's approval with who, when and why, its properties typed per kind, a BLOCKED one on no new BOM line and in no release; names per language; pictures (one main per style: a partial unique; frozen with a released revision but for their place and main mark); revision files (PATTERN and CAD frozen with a released revision); product types (one kind up the tree, no circle, defaults that fit); GTIN ranges (next never back, limits fixed once used, never deleted); branding sets (a brand, its own files, library colours, packaging rules, one ACTIVE per company and brand: a partial unique); product settings; its own triggers on Style, Variant, Colour, Item, BomLine and StyleRevision, no earlier function redefined, `…_sizes_measures_w2b_guards` (W2b-4 schema wave 27/33, B-W2b-210: a scale of one or two dimensions and a size's fit, points of measure (kind and unit fixed once named, a garment point's body point, the picture a photo of the point), measurement specs and their values and protector placement as parts of the revision (W1's `factory_style_revision_part_guard` as it is), one live spec per revision (a partial unique), an approved spec's values frozen until it is reopened, grade rules with one standard increment per point (a partial unique), prepacks of a style or a scale with one line per size (a partial unique), template points of a body point with their limits, the plausibility rules, the base size rule, a BOM line's made-to-measure point of the style's template; no earlier function redefined, `…_bom_options_w2b_guards` (W2b schema wave 28/33, B-W2b-211, BOM depth and the option library: a line's group row with no circle, a sub-assembly (a revision of another style, DRAFT or RELEASED when named, the line a COMPONENT we make in PCS, PAIR or SET, no circle of styles, at most 10 levels: transaction advisory locks), RELEASED when its parent is released, customer-supplied material (a CUSTOMER or BRAND party, no supplier), the source rule's key, an option line of a group the style offers; a revision's output (1-1000 PCS, PAIR or SET; frozen by 205's guard); line alternates as parts of the revision (W1's part rule as it is; removed with their line; not the line's material, not BLOCKED, a certificate check for a PPE component; a release refused while one is BLOCKED); option groups (SINGLE takes 1 at most), values (the free-text rule), rules (requires or excludes, block or warn, of the group's company), effects (each kind its own columns; price @grain price), style offers (one ACTIVE per style and group: a partial unique; removed only while no line or routing step is for its values) and the routing step's option values checked at last; its own triggers on BomLine, StyleRevision and RoutingOperation, no earlier function redefined, `…_changes_samples_w2b_guards` (W2b schema wave 29/33, B-W2b-212, change control, release and samples: change requests (a floor device inserts its own, numbered later by the office; never deleted), change orders DRAFT → SUBMITTED → APPROVED → RELEASED with their lines only while DRAFT, approvals decided once while SUBMITTED by someone who is not the author (one live change order per proposed revision: a partial unique), sample rounds (cells, the pinned revision, a decision by the office or as the brand's answer to its approval request, frozen once decided), fit measurements against the frozen spec, comments, swatches, sample shipments, order gates (one per kind but OTHER: a partial unique; an override by someone who is neither owner nor maker); its own triggers on StyleRevision (the release scope only widens; the completeness score once) and WorkOrder (a SAMPLE work order and its round); it redefines B-W2b-205's `factory_style_revision_guard` (a released revision also moves its release scope and score), W2a's `factory_work_order_size_guard` (a SAMPLE cell names a SIZE_GRID line) and plant care's `factory_stored_file_floor_guard` (a floor photo of a change request), `…_compliance_rules_w2b_guards` (W2b schema wave 30/33, B-W2b-216, the compliance rule library: register entries (one per code without an edition: a partial unique; no circle of successors), standard changes OPEN → ASSESSED → CLOSED (the assessment filed once, a CLOSED one frozen, the certificates and type-change reviews it names checked), markets (a country code, languages, marks, national rules; switched OFF only with a reason), requirements (OFF only with a reason; a gate the law locks stays locked and blocked, the requirement on and ACTIVE, its kind, check, scope and dates fixed), gate events append-only (a refusal by an ACTIVE switched-on requirement that blocks that gate; an override never from the floor, of a refusal of the same gate, subject and requirement, not at a locked gate, with a step-up of at most 15 minutes before and an end within the requirement's days), economic operators (a style or a brand, a party for every role but MANUFACTURER), phrases (the revision up by one with new source words), translations (inserted DRAFT, approved by someone other than their author on the phrase's current revision, then frozen; one APPROVED and one DRAFT per phrase and language: partial uniques; only a DRAFT removed), notified bodies (four digits, one ACTIVE per number: a partial unique; the number fixed once a certificate names it); its own triggers on Certificate (the body's number is the typed one; body, levels and base certificate filled once after DRAFT; an own-brand certificate held by a brand rests on a company's certificate with no base) and CertificateCoverage (a bought-in part's supplier named once), no earlier function redefined, `…_substances_w2b_guards` (W2b-4 schema wave 31/33, B-W2b-217, materials and restricted substances: substances with their CAS and EC check digits (given once; one ACTIVE per CAS: a partial unique), lists and Annex XVII entries; substance rules (one substance or group, a limit with its unit and bound, a CUSTOMER rule with its brand, switched OFF with the reason); Candidate List versions fixed once published and kept while named (a BEFORE DELETE trigger); material profiles (the SVHC answer with its list version and SVHCs, what the evaluator found, BLOCKED with why); declaration requests SENT → ANSWERED | OVERDUE | CANCELLED → ACCEPTED | REFUSED (the answer a portal upload or a file of the request, set once; accepted with every line answered), their lines only while open (an SVHC above 0.1 % w/w); test plan rules (a kind or a material, a rule of its own test); it redefines W1's `factory_lab_result_guard`: CR_VI as it was, the new tests AZO, NICKEL, PAH, DMFU, NPE, PFAS with their method, unit and the rule's limit, `…_techfiles_labels_w2b_guards` (W2b schema wave 32/33, B-W2b-218, declarations, technical files and labels: a GENERATED compliance document stays a DRAFT (or WITHDRAWN) until GATE-PPE-TEXTS, carries its Annex IX content or Annex II 1.4 sections with their sources and names the brand as maker only when the brand sells the style under its own name; translations of an original of the same style and kind in another language, CHECKED by someone other than their author before issue; the new document and label template columns fixed once out of DRAFT; batch records written once and kept ten years (retainUntil, no delete before; one per document and batch without a shipment: a partial unique); technical files numbered (TECHNICAL_FILE), one live per style (a partial unique), COMPLETE only with every Annex III point (a)-(m) reviewed or not applicable, ARCHIVED then kept ten years; their items written only while OPEN; risk assessments DRAFT → SIGNED (one per file: a partial unique) → SUPERSEDED with rows only while DRAFT; production-control tests recorded once and kept ten years after the test day; evidence packs numbered (EVIDENCE_PACK), BUILDING → BUILT (contents with SHA-256, files of the pack, kept ten years) or FAILED; artwork versions approved by someone other than their author (one APPROVED per template revision: a partial unique); spoiled and returned labels append-only, at most a print's quantity; its own triggers on ComplianceDocument and LabelTemplate (W1's guards untouched); it redefines wave 15's `factory_generated_document_check` (COMPLIANCE_PACK, EVIDENCE_PACK, TECH_PACK, USER_INFORMATION), `…_recall_claims_w2b_guards` (W2b-4 schema wave 33/33, B-W2b-222, recall, authority and claims: authority notices drafted for an OPEN register entry and a market of the tenant, sent once by a person (a RISK only once the entry's risk is YES), then frozen but the authority's reference and the copy, filled in once; recalls and withdrawals numbered (RECALL), of the entry's style, DRAFT → ACTIVE → CLOSED (or CANCELLED), the scope (the whole style or batches, serials, work orders, shipments) set while DRAFT and only widened once started, the public notice per language published once by a person while ACTIVE and never changed after (a language may be added), taken down once; their progress adding up (sent = returned + repaired + destroyed + still out), of a shipment of its own customer, written while the recall is DRAFT or ACTIVE, removed only while DRAFT; distributor notices DRAFT → SENT → ANSWERED | FAILED (or CANCELLED), an address for their way, what was sent never changed; authority requests numbered (AUTHORITY_REQUEST), received not in the future, due not before, the evidence by record type + id, the register entry of their style set once, frozen once answered; sustainability claims approved with available evidence of their company that has not expired, then frozen but their withdrawal; claim uses only while their claim is approved and holds, ended once; nothing deleted but a DRAFT recall's progress; it redefines F1's `factory_ppe_register_entry_guard`: word for word, with the source type AuthorityRequest), `…_followups_product_w2b4_guards` (W2b-5 schema wave 34/44, B-W2b-275, the W2b-4 follow-ups for product, samples and compliance: point of measure codes unique whatever the case (an index on lower(code)), a style's markets by their codes, the lab's cost of a lab result with its currency, PPE text approvals recorded once and withdrawn once, never deleted; it redefines B-W2b-212's `factory_work_order_size_guard` (a SAMPLE cell may name no order line, with its party, both or neither), wave 10's `factory_inspection_measurement_guard` (the asymmetric band and the pass written from it), and B-W2b-218's `factory_compliance_document_w2b4_check` (a generated document leaves DRAFT only while a live PpeTextApproval of its template covers it) and `factory_compliance_document_batch_check` (a SUPERSEDED document for a batch made while it was in force)), `…_approvals_w2b_guards` (W2b-5 schema wave 35/44, B-W2b-276, approvals and workflow: approval rules (a RuleBuilder condition, exactly one approver: an OFFICE role or one OFFICE person who has not left, kind, company and creation fixed, switched off and never deleted); requests for a yes asked PENDING, what was asked fixed, decided once (APPROVED with when, who, a comment, the step-up within 15 minutes where asked; REJECTED with an APPROVAL_REJECT code and words) or WITHDRAWN or STALE, never deleted, and NEVER DECIDED BY THE PERSON WHO ASKED (nor the writer, nor the office account of the worker who asked; a named approver is never one of them and is the only one who decides; Owner answer Q3 = A); the history append-only, a task's line agreeing with its task, a domain approval's decision never by the person of the record's last REQUESTED line; no earlier function redefined; it calls recall's `factory_recall_words_ok`, `factory_recall_not_future` and `factory_recall_model_name_ok`),
   `…_warehouse_depth_w2b_guards` (W2b-5 schema wave 36/44, B-W2b-277, the warehouse in depth: a bin label's code, a block that
   refuses moves in and out (but a COUNT) until it ends, a CUSTOMER place of a customer or brand; TRANSFER_OUT / TRANSFER_IN naming
   their transfer line, the ship onto and the receipt off the from-site's TRANSIT place, which only a transfer moves; a frozen count
   line refuses moves of its item at its place until counted; a posting date within the company's back-dating limit (today's from
   the floor); the lot's lifecycle kept in step with its quality status (its own trigger `Lot_lifecycle`, which writes NEW), its
   parent lot and typed attributes; goods without a PO held in a place and posted only once a purchase order names them; default
   locations (one active per site, kind and purpose: two partial uniques), transfers numbered (TRANSFER) with their DDT from
   SHIPPED on, count schedules, scans append-only (a RECOUNT another person's), warehouse rules, the task inbox, substitutes nobody
   decides for themselves; its own triggers `StockMove_warehouse_check`, `Location_w2b_check`, `GoodsReceipt_unplanned_check`; it
   redefines W1's `factory_lot_guard` (a REJECTED lot's lifecycle moves), W2a's `factory_location_party_guard` (CUSTOMER),
   `factory_stock_move_period_lock` (the posting date), `factory_stock_count_guard` (freezeMoves chosen while DRAFT, the count's lock
   when it leaves COUNTING, the counter-not-approver switch and scans) and `factory_stock_count_line_guard` (a floor session: the
   count's lock instead of its row, ADDED lines and its count only; frozenAt; a recount by another person)),
   `…_sales_intake_w2b_guards` (W2b-5 schema wave 37/44, B-W2b-279, sales intake and customers: inquiries numbered (INQUIRY),
   logged open, NEW → ASSIGNED ⇄ NEED_INFO → QUOTED (with the quote, one inquiry per quote) | DECLINED (with the reason) | LOST
   (with words), then frozen but the note and the prospect's erasure; a party or a prospect with its lawful basis, one inquiry per
   mail (partial uniques), the tech pack's files of the inquiry or its mail, the prospect blank for good once erased; their lines
   only while open, sizes and total that agree; customer requirements fixed once written, ended once, superseded by a new row
   (once: a partial unique); holds placed with words, never edited, released once (one in force per party, company and reason:
   a partial unique); terms per company of a tenant-wide customer (one live per party and company: a partial unique), frozen
   once ended; seasons with their code fixed, CLOSED with its time; its own triggers on QuoteVersion and SalesOrder (an OPEN
   season of their company), Party (a rider under a team is a PERSON, a team with riders stays an ORGANISATION) and
   PartyContact (consent with when and how; an erased contact archived and blank for good); no earlier function redefined),
   `…_sales_pricing_w2b_guards` (W2b-5 schema wave 38/44, B-W2b-280, quotes, pricing and configuration: quote templates (company and creation fixed, a deposit for a paid acceptance, never deleted) and their lines (SIZE_GRID or FEE, a style of the template's company); a quote's template named once; a SENT version's reminder set or moved later by the office only; the Incoterm with its place on versions and orders; a FEE line's fee kind; the price waterfall (QuoteLine / SalesOrderLine.priceSteps) adding up to the unit price, dropped by a BEFORE trigger when a price changes without it; delivery schedules and chosen options as parts of their line (the quote DRAFT, the order CONFIRMED, IN_PRODUCTION or READY; a size never scheduled beyond the line's; a free text by its value's rule; none on a FEE line); quantity breaks and version size surcharges only while the version is a DRAFT (partial uniques for the version-wide and style rows); an entry's dated validity; minimum order rules; size curves totalling 100; margin floors by office role; a work order cell's option values chosen on its order line, never a FEE line's cell; it redefines W1's `factory_quote_version_guard`: word for word, the reminder one more change of a SENT version),
   `…_sales_orders_depth_w2b_guards` (W2b-5 schema wave 39/44, B-W2b-281, orders, credit and changes: an order waits for a yes (PENDING_APPROVAL) only from its making, then CONFIRMED or CANCELLED, its lines and sizes changing meanwhile, nothing made, shipped or confirmed for it; URGENT with its reason; the confirmation sent a version of its own ORDER_CONFIRMATION, never going back; a priced amendment (parts with signed amounts, a fee, an extra deposit of the same order of at most the growth, once; the new yes a SALES_ORDER_CHANGE of its order); the caparra penitenziale only while the company's sales settings switch it on (GATE-ACCOUNTANT); freeze rules (one active per company, field and stage: a partial unique; a later stage never loosens an earlier BLOCKED; never deleted); credit checks append-only (a record of the step and of its customer and company, sums that add up, a result that fits, an override naming its HOLD and an APPROVED CREDIT_OVERRIDE about it, once); a customer's materials (a BOM line the customer sends, counts that add up, removed only while nothing moved); customer-owned lots (owner fixed, a CUSTOMER or BRAND party, a CUSTOMER_SUPPLIED receipt's lots owned by its sender and no others) never valued or costed, issued and held only for their owner's orders, never matched to a supplier invoice; it redefines W1's `factory_sales_order_guard` and `factory_sales_order_line_size_guard`, wave 3's `factory_sales_order_line_guard` and wave 32's `factory_generated_document_check` (ORDER_CONFIRMATION of a SalesOrder), and calls recall's three helpers and `factory_styles_decimal_ok`),
   `…_buying_depth_w2b_guards` (W2b-5 schema wave 40/44, B-W2b-285, buying and subcontracting in depth: a purchase order waits for its yes as PENDING_APPROVAL with its approval task (by id), frozen, then is sent with it or goes back to DRAFT; the send's checks run when it asks too, with each live line's deliveries adding up to it and a foreign currency's rate and value in the company's currency; a SAMPLE order's style and round of its company; a third party to ship to, its usable address and its workshop place; a line's rolls, a protector's VALID covering certificate, an ACTIVE variant of the line's (and a lot's) colour, a lot of a variant's line of that variant; delivery schedules written while DRAFT, each delivery confirmed once (a partner session while SENT); a set confirmed date (a line's or a delivery's) moved only to its newest PoDateChange (append-only, checked both ways: the other at commit); tolerances and variants never deleted; requests to buy OPEN → PENDING_APPROVAL → OPEN → CONVERTED | REJECTED | CANCELLED; a SENT kit line's material balance (append-only, under a lock per line: never more than sent, never below 0) and the workshop's cost entries (append-only, a reversal once); its own triggers on PurchaseOrder, PurchaseOrderLine and Lot; it redefines the portal follow-ups' `factory_purchase_order_guard` and the supplier portal's `factory_purchase_order_line_guard`),
   `…_planning_depth_w2b_guards` (W2b-5 schema wave 41/44, B-W2b-286, planning in depth: planned work and subcontract orders (the size run adds up, MAKE on a line, SUBCONTRACT to a workshop with its steps and kit date, firm and protected fields with who and when, made real once then frozen, moved on only by a later run, removed only while plain), MRP action messages (each action's from and to, about a record of the run's site, decided once while the run is DONE, never deleted), the promise history and the board's change log append-only (one FIRST per line and size, one undo per change: partial uniques), what-ifs DRAFT then applied or discarded once, a workshop's weekly capacity, and its own triggers on ItemPlanning (lot sizing, scrap, yield, delays, plan level and strategy of made items, phantom components), PlanningSettings (the size groups), PlanningRun (the inputs object), MaterialRequirement (the hard peg), SalesOrder (the backlog rank), ScheduleSlot (a pinned slot stays put), SubcontractOrder (the kit date) and WorkOrderOperation (outside with a live subcontract order); it redefines supply's `factory_material_requirement_guard` (the hard peg set while OPEN), W2a's `factory_schedule_slot_guard` (the pin is part of a move) and W2b-2's `factory_work_order_operation_guard` (outside or back in while RELEASED, IN_PROGRESS or ON_HOLD)),
   `…_suppliers_depth_w2b_guards` (W2b-5 schema wave 42/44, B-W2b-287, suppliers in depth: a party's supplier kinds and status only with a supplier role, each status change with when and by whom, a hold's reason, never cleared, the origin and a tannery's hides and tannages (its own triggers `Party_supplier_check_insert` and `Party_supplier_check`, AFTER UPDATE OF the new columns only); what a contact receives each once; bank accounts NEVER CHANGED IN PLACE: proposed PROPOSED (the IBAN's ISO 7064 check digits; the masked IBAN written by a BEFORE INSERT trigger; a portal session proposes only for its own party by its own person), the call-back once to a contact or address phone on file before the proposal and unchanged since, by someone who neither proposed nor wrote it, the second person's check after it (nobody verifies their own change, the Owner included: Q3 = A), one ACTIVE per party and currency (a partial unique), refused and retired once, never deleted; qualifications PENDING → APPROVED | CONDITIONAL | REFUSED, suspended and lifted back, withdrawn, their scope by role and library and their evidence (accepted, of the party) fixed once decided, never deleted; subcontract agreements DRAFT → SIGNED with an available file → SUPERSEDED | TERMINATED, one SIGNED per company and workshop (a partial unique), only a DRAFT deleted; no earlier function redefined; it calls recall's `factory_recall_words_ok` and `factory_recall_not_future`),
   `…_service_safety_w2b_guards` (W2b-5 schema wave 43/44, B-W2b-291, returns, repairs, service and product safety: return policies (at least 14 days for consumers at a distance, the withdrawal words only for them, one live per company and channel: a partial unique; one an RMA names keeps its terms) and fee rules (a percent or an amount, the reason group's codes; one a line names keeps its terms); an RMA's scan code set once, its finish reason only when CLOSED, its policy and withdrawal only before the goods arrive; repair estimates DRAFT → SENT → ACCEPTED | DECLINED (or WITHDRAWN), what was sent frozen, lines only while DRAFT; service cases numbered (SERVICE_CASE), NEW → OPEN → WAITING_CUSTOMER | WAITING_PART → RESOLVED → CLOSED, the cover decided with its guarantee and words, links only while open; safety reports numbered (SAFETY_REPORT), seen once, a SAFETY case and the register entry set once, the reporter's data erasable after CLOSED; the injury apart (one per report: its key `injury:<report>`, words only with the consent, erased once, never a search entry: `SearchEntry_not_injury`); the accident log append-only by revision; its own triggers on ReturnAuthorisation and RepairOrder (the new columns); it redefines W2a's `factory_return_line_guard` (a line split after a partial receipt with the deferred `ReturnLine_split_kept`, credit without the goods, the size exchange, the fee dropped when the cause is ours, the garment and lot of ours, never a sample made for no order) and B-W2b-222's `factory_ppe_register_entry_guard` (source type ProductSafetyReport); it calls `factory_document_number_guard`, `factory_money_rome_day`, recall's three helpers and approvals' `factory_approval_code_ok`),
   `…_mtm_office_w2b_guards` (W2b-5 schema wave 44/44, B-W2b-297, the made-to-measure office, built OFF: a measurement profile's factory review WAITING → CONFIRMED | NEED_MORE (NEED_MORE again or CONFIRMED; CONFIRMED final), who and when exactly once reviewed, the words to ask for more, nobody confirming measures they took themselves (Q3), who of ours measured (an office person, never on a link send) and where, given once; appointments inserted BOOKED, then DONE | MISSED | CANCELLED and frozen but their notes and the revision a DONE one led to (once), at most 24 hours long, a FITTING of a profile revision, a DONE one with who was there, a cancel with why; fitting results of a FITTING appointment and/or a MADE_TO_MEASURE order line of the fitted revision, per point the change asked (points of the profile, in their unit), OK | ALTER | REMAKE, written once but the ALTERATION repair it opened and the later revision it led to, named once each; a MADE_TO_MEASURE quote or order line of a style flagged made-to-measure (PRD-017; its own triggers `QuoteLine_mtm_style`, `SalesOrderLine_mtm_style`); it redefines the portal step's `factory_measurement_profile_portal_guard` (the review columns move) and wave 39's `factory_generated_document_check` (MTM_WORKSHEET of a MeasurementProfile, any company of the tenant, no site); it calls recall's `factory_recall_words_ok` and `factory_recall_not_future`),
   `…_planning_board_record_guards` (B-W2b-F39: the board's record keeps its own copy of the operation it names; its schema
   folder drops ScheduleChange's foreign key to WorkOrderOperation and adds `operationSeq`, `operationName`; its own trigger
   `ScheduleChange_operation_copy` checks the copy against the operation at insert; the changes written before it keep no
   copy (filling them would change an append-only ledger); no earlier function redefined):
   `…_production_option_steps_w2b_guards` (B-W2b-F40, no schema folder of its own: a work order is released with the
   routing steps its cells are for, as factory-domain's `stepIsFor` reads them (a step only for sizes, colourways or
   options none of its cells has may be left out; every other step stays required); it redefines W2b wave 7's
   `factory_work_order_guard`, the rest of the body word for word):
   `…_followups_sales_w2b5_guards` (W2b-6 schema wave 45/57, B-W2b-363, the W2b-5 follow-ups for sales, buying and
   approvals: REMAKE as a return's wish, marked once by the office while the RMA is open; MTM_PHOTO (of a MeasurementProfile)
   and FITTING_PHOTO (of a FittingResult) PHOTO files, the office's only, with a delete date (`StoredFile.deleteAfter`: only
   theirs, not before retainUntil, moved but never cleared, fixed once DELETED, still set on a superseded version); a supplier
   file's document type, an ACTIVE code of the new SUPPLIER_DOCUMENT_TYPE reason list, only on a vault category; option groups
   that take a COLOUR or a MATERIAL (the line options of a COLOUR group pick no material, of a MATERIAL group no library colour;
   a group takes one only while none of its options picks the other); PRICE_LIST of a PriceListVersion; quote and timesheet
   approvals never by the person who asked or the person's own office account (Q3 = A, own triggers `QuoteApproval_not_own`,
   `TimesheetApproval_not_own`); a receipt line held for a yes, never POSTED while held; the confirm-by 1-720 hours and the
   reminder cadence 1-30 days; a CHASE only while the order waits for goods, of its current revision; the partner's `iban` is
   write-only (ownership `writeOnlyColumns`, which db-kit's policySql leaves out of the SELECT grant only; one open IBAN per
   party stays an API rule: a partial unique broke the isolation copy); a FEE line credited against another order of its company and
   customer with goods lines, not cancelled, whatever its own order's state, fixed once credited; a reason group's words; it
   redefines the portal follow-ups' `factory_return_request_check`, wave 18's `factory_stored_file_guard` (`deleteAfter`
   among a superseded version's moves), wave 44's `factory_generated_document_check` and wave 39's
   `factory_sales_order_line_guard` (the fee credit changes in any state); it calls recall's `factory_recall_words_ok` and
   `factory_recall_not_future`):
   `…_packing_w2b_guards` (W2b-6 schema wave 46/57, B-W2b-364, packing and the shipment queue: packaging types (name,
   inner size all or none, tare below the maximum weight, a pallet kind exactly on a PALLET, the cost with its currency;
   company and kind fixed) and defaults per style or size run (one live per company, kind, style and run: a partial unique);
   carton contents (ParcelLine) written only while the shipment is a DRAFT, the size the line's, no cap while DRAFT but at
   DRAFT → PACKED each line with contents counted exactly; mark templates (1 to 16 fields each once, an ISO 639-1 language,
   one live per company and customer or default: a partial unique); holds on a shipment placed only while DRAFT or PACKED
   (the shipment FOR NO KEY UPDATE), never edited, released once with why, one in force per shipment and reason (a partial
   unique); while one is in force nothing goes into the shipment's cartons or parcels, no carrier label, no move to PACKED or
   SHIPPED (`factory_packing_refuse_held`, the shipment FOR SHARE); cut-offs per site, carrier and weekday (HH:MM); its own
   triggers on Shipment (the split from a DRAFT or PACKED shipment of the same order, given once; the PACKED checks of
   contents, serials per carton and "n of N"), Parcel (its packaging a CARTON, BOX or PALLET of the shipment's company,
   ACTIVE; "n of N"; not removed with contents), ShipmentLine (not removed with contents, its size not changed under them)
   and GarmentSerial (the carton of its line's shipment, set while RELEASED and DRAFT; `GarmentSerial_unpack_carton`, a
   BEFORE trigger that fires after the guard, clears the carton when the line is cleared); no earlier function redefined;
   it calls recall's `factory_recall_words_ok` and `factory_recall_not_future`):
   `…_notify_depth_w2b_guards` (W2b-6 schema wave 47/57, B-W2b-366, notifications, My work and mail in depth: an office
   person's notification preferences and an office role's defaults (person or role, kind, channel and key fixed, the key
   beginning `pref:`/`default:` with them: one row each; the daily digest only on EMAIL); push subscriptions (the endpoint
   https and fixed, a live one with its keys sealed as a SecretValue of purpose `notifications.push`, the keys going only
   once it is turned off, turned off once and then frozen, one live per endpoint: a partial unique; never deleted); view
   follows (the key `view:<view>:<person>`, an ONLY_ME view followed only by its owner, the last count all three or none
   and only forward; removed with their view: ON DELETE CASCADE); reminders (born waiting, AT_TIME with a time after
   `since`, a new time or kind only with a later `since`, came back once and cleared only by a put-off, done then frozen
   but for Undo, a message of the record's own thread); team inboxes (the local part, not `r-`/`c-`, members office people
   each once; never deleted); capture addresses (a base32 token, the default inbox switched on, turned off once then
   frozen, one live per company: a partial unique; never deleted); InboundEmail's team-inbox columns (its own triggers
   `InboundEmail_team_inbox_check` and `InboundEmail_follow_up_ends`: a later MATCHED mail on the thread clears the earlier
   mails' follow-ups); EmailOutbound.bounceKind written PERMANENT with bouncedAt by its own BEFORE trigger
   `EmailOutbound_bounce_kind` (and filled for the rows that bounced before); SalesSettings.inquiryAddresses checked by its
   own trigger; it redefines W0's `factory_inbound_email_guard` (a MATCHED mail's team-inbox columns still move), the rest
   word for word; it calls recall's `factory_recall_words_ok`, `factory_recall_not_future` and
   `factory_recall_model_name_ok`):
   `…_carriers_w2b_guards` (W2b-6 schema wave 48/57, B-W2b-367, carriers, labels and dispatch: our own carrier contracts (the
   number a SecretValue of purpose `shipping.carrier_account`, required while live; company, site, carrier fixed; one live per
   company, site or every site, and carrier: a partial unique; never deleted), pickups (what was asked fixed; REQUESTED →
   CONFIRMED | FAILED | CANCELLED, CONFIRMED → FAILED | CANCELLED, the last two final; the provider's reference set once; why it
   failed exactly when FAILED; an address with a two-capital country; never deleted) and day sheets (company, site, carrier and
   day fixed; closed once with when and its own file, then frozen; one per site, carrier and day; never deleted); its own
   triggers on Shipment (a hand-typed tracking number only for a CARRIER shipment with no Sendcloud shipment; who collected, the
   plate and a signature of the shipment only when the customer collects; a day sheet only for a CARRIER shipment of its
   carrier, PACKED or gone, on and off only while the sheets are open (FOR SHARE), never back to DRAFT or CANCELLED on one),
   Parcel (declared value 0 or more, insured above 0 and at most declared), ShippingSettings (live exactly with when and who,
   fixed while live, cleared in test mode), Party (the customer's carrier account a SecretValue of purpose
   `parties.carrier_account` with its preferred carrier; COLLECT and THIRD_PARTY only with it), Printer (DIRECT only on a label
   printer) and PrintJob (a reprint of the same record with 3-200 characters of why, fixed once queued); it redefines the
   portal follow-ups' `factory_shipment_guard` (the hand-typed tracking number and the day sheet still change once the goods
   left) and wave 45's `factory_generated_document_check` (PROFORMA of a Shipment, SampleShipment or DepositRequest with its
   record's PROFORMA NumberAllocation; MANIFEST of a DispatchManifest; SHIPPING_MARKS and SHIPMENT_PACK of a Shipment); it calls
   recall's `factory_recall_words_ok` and `factory_recall_not_future`):
   `…_tax_currency_w2b_guards` (W2b-6 schema wave 49/57, B-W2b-369, invoicing, tax and currency: tax codes as data (a rate or a
   Natura with its law, ACTIVE versions of a code that never overlap: a transaction advisory lock per code; a version in force
   never edited, ended from yesterday on and a new one made; VERIFIED never back, the accountant's confirmation once; deleted
   only before its first day); declarations of intent (the tax agency's protocol, used up to the amount, the check with its
   receipt once, one live per protocol: a partial unique; revoked then frozen; never deleted); stamp duty quarters (paid after
   the quarter, then frozen); self-invoices PENDING → ISSUED | CANCELLED (one live per supplier invoice: a partial unique; its
   invoice of its type, issued); e-invoice test mode (live with when and who, fixed while live); our own copy of an SDI send
   (keyed `sdi:<send>`, receipts only added); invoice runs PREVIEW → ISSUED with no draft left; deposit rules on cancellation
   (one ACTIVE per company, kind, side and order type: a partial unique); currencies (the base one never off; one active per
   code: a partial unique) and exchange rates (keyed `<base>:<quote>:<day>:<source>`, an ECB one EUR-based and never changed,
   only a MANUAL one removed); the payment terms' skipped months; GATE-ACCOUNTANT: CompanyEInvoiceSettings' switches, OFF by
   default, hold an invoice naming a declaration of intent, a STAMP_DUTY charge line (one per invoice: a partial unique) and a
   TD16-TD19 leaving DRAFT; its own triggers on Invoice (language, rate, run, declaration, debit note TD05), InvoiceLine and
   PaymentTerms; it redefines W2a's `factory_invoice_check_issue` (the SELF_INVOICE series for TD16-TD19), the rest word for
   word; it calls recall's `factory_recall_words_ok`, `factory_recall_not_future` and money's `factory_money_rome_day`):
   `…_bank_bridge_w2b_guards` (W2b-6 schema wave 50/57, B-W2b-370, bank, receivables, payables and the accountant's bridge:
   a company's own bank accounts (the IBAN's check digits; company, IBAN and currency fixed; one live per company and IBAN: a
   partial unique; switched off, never deleted; the migration's data copy fills each company's first one from its Company
   bank columns, which stay), statement files and their lines never changed (a live account, the period not after today, the
   file of the company; a line inside its statement's days in the account's currency, its fingerprint unique per account),
   matches (money in: issued TD01 / TD24 invoices and deposit requests of the party, or a payment typed by hand; money out:
   one supplier invoice; accepted once with the payment it recorded, RECEIVED for the line's amount; reversed once after
   that payment is VOIDED; one live acceptance per line and per payment: partial uniques; only a suggestion deleted),
   write-offs append-only (an UNDERPAYMENT on an allocation to an invoice, an OVERPAYMENT of the payment; within the
   company's tolerance in force; the caps under the money locks; a reversal once), Ri.Ba. batches DRAFT → ISSUED (only while
   the company's `ribaOn`, with its file, each instalment once and in no other issued batch) | CANCELLED and their items
   (an instalment of the invoice's payment terms inside the window, added and removed while DRAFT, then PAID | UNPAID with
   the bank's fee, once), reminder stops (a promise names its day; lifted once; never deleted), a customer's own figures
   (their shape), payment proposals DRAFT → APPROVED (never by the person who made it, Q3 = A; each invoice APPROVED, once,
   in no other live proposal, paid to the supplier's ACTIVE account) → PAID (every invoice PAID) | CANCELLED and their lines
   (only while DRAFT), account mappings (fixed from their first day), the bridge settings, exported documents (written while
   the export is a DRAFT, flagged once after it), integrity check runs append-only; its own triggers `Payment_write_offs_check`,
   `PaymentReminder_stopped`, `AccountingExport_documents_once` (a document once per export, NEW in no other exported one,
   CHANGED only after one), `ReceivablesSettings_bank_check`, `Party_reminder_trusted_check`; it redefines the followups'
   `factory_payment_allocation_check` and `factory_refund_guard` (the write-offs counted; their messages unchanged while
   nothing is written off); it calls suppliers' `factory_supplier_iban_ok`, `factory_supplier_list_ok`,
   `factory_supplier_office_person_ok`, recall's three helpers and money's `factory_money_lock`, `factory_money_rome_day`,
   `factory_invoice_credited`):
   `…_delivery_customs_w2b_guards` (W2b-6 schema wave 51/57, B-W2b-372, delivery, returns and customs: tracking problems raised
   on a shipment that left (one open per shipment and kind: a partial unique; an open one only while SHIPPED), their task named
   once, resolved once then frozen; return labels made OFFERED (a RETURN_LABEL link of the RMA) or BOOKED while the RMA is
   AUTHORISED or RECEIVED, OFFERED → BOOKED | CANCELLED, BOOKED → USED | CANCELLED, the booking reference and the label (a file
   of the RMA) together from BOOKED on, each set once; customs declarations made PACK_SENT, PACK_SENT → FILED → EXITED, the MRN
   from FILED on (set once), the exit (when and its proof, a file of the declaration) exactly when EXITED against an issued
   invoice once the goods left, removed only while PACK_SENT; the proof of delivery only on a DELIVERED shipment, each part set
   once (`Shipment_pod_check`); an order's deliveredAt exactly in the move SHIPPED → DELIVERED with a delivered shipment and
   none travelling (`SalesOrder_delivered_check`); the EORI's shape (`Company_eori_check`); a BROKER_PACK link of a declaration
   of its company and broker while PACK_SENT and the site's broker pack switched on, a RETURN_LABEL link of an open RMA of its
   company and party (`OneOffLink_delivery_customs_check`); it redefines 367's `factory_shipment_guard` (the proof of delivery
   still changes once the goods left) and `factory_generated_document_check` (COMMERCIAL_INVOICE, CN22, CN23 of a Shipment),
   wave 39's `factory_sales_order_guard` (DELIVERED only from SHIPPED, then only CLOSED) and wave 19's
   `factory_link_file_guard` (a BROKER_PACK link carries files), each word for word but for that; it calls recall's
   `factory_recall_words_ok`, `factory_recall_not_future` and carriers' `factory_carriers_code_ok`):
   `…_security_audit_w2b_guards` (W2b-6 schema wave 52/57, B-W2b-373, security and audit in depth: the tenant's security
   settings (office idle 15 minutes to 24 hours and longest 1 hour to 30 days; portal idle 5 to 30 minutes and longest 1 to 12
   hours, never beyond what `Session_audience_guard` holds; step-up locks after 3 to 10 failures for 5 minutes to 24 hours;
   the actions switched off by their keys, each once; never deleted); a custom role archived by someone (both or neither),
   only while nobody holds it, frozen until restored on its own, never given while archived (`RoleAssignment_role_archived`,
   `WorkerRole_role_archived`: the role FOR SHARE), never deleted (`Role_custom_never_deleted`; a system role is never
   archived and may still go with its template); a session's device, browser, country and city set once
   (`Session_device_check`); step-up tries append-only, the fingerprint of the code that worked exactly on SUCCESS (once per
   person: the unique key), the lock counted per person under a transaction advisory lock (the tenant's failures in a row
   since the last SUCCESS within its lock time; LOCKED exactly while locked); security events append-only (the site exactly
   on FLOOR, a party only on PORTAL or LINK, API_KEY_USED only on API, nobody known only for SIGN_IN_FAILED and API_KEY_USED,
   the address as a 64-hex keyed hash, details as codes without `@`); reads of sensitive records append-only, only the
   record types of `factory_read_log_record_type_ok`, only an office person's (OFFICE, API or SYSTEM); its own triggers on
   Role, RoleAssignment, WorkerRole and Session, no earlier function redefined; it calls recall's `factory_recall_words_ok`,
   `factory_recall_not_future` and `factory_recall_model_name_ok`):
   `…_privacy_integration_w2b_guards` (W2b-6 schema wave 53/57, B-W2b-375, privacy duties and the error queue: data requests
   born RECEIVED for a person's record of their kind (WORKER a Worker or an Employee, USER a User, CONTACT a PartyContact,
   PROSPECT an Inquiry, REPORTER a ProductSafetyReport) of the request's company, due exactly 720 hours after receipt,
   extended once (at most 2160 hours after receipt) with the reason, the identity check once, RECEIVED → IN_PROGRESS → DONE
   (the identity checked; ACCESS with its package, an AVAILABLE file of the request; ERASURE with an ErasureRecord) | REFUSED
   (with the reason) | WITHDRAWN, then frozen, never deleted; erasure records append-only, for exactly one ERASURE request
   IN_PROGRESS (FOR SHARE) or one APPLY sweep RUNNING whose rule's action they follow, naming real columns of the record's
   table (pg_attribute; never id or tenantId), what stays with why; retention rules (a table of the database, the key
   `retention:<type>:<company | all>`, 1-1200 months, the legal reason; GATE-PRIVACY: `applyOn` with when and by whom, only
   while active, OFF by default) and sweeps (an APPLY sweep only of a rule switched on, FOR SHARE; the rule's period as it
   stood, the cut-off the business day (`factory_money_rome_day`) less its months; counts that never go down; finished once;
   never deleted); failed messages born OPEN of a source row that failed (a DEAD or PUBLISHED outbox event, a FAILED or
   REJECTED webhook, a FAILED, TIMED_OUT or REFUSED call; its provider, a call's operation, its company), the key
   `<outbox | webhook | call>:<source>`, RETRIED → OPEN only with one more try after the retry, DISMISSED with a reason and
   frozen, deleted only closed 720 hours after; job runs one per tick and tenant (the key `<job>@<epoch seconds>`, or
   `<job>@now:<request>` with who asked), finished once, the error exactly when FAILED, deleted only 168 hours after they
   finished; its own trigger `SalesSettings_safety_report_form_check` (the outside doors of safety reports switched on only on
   a company's own row while its SAFETY_REPORT notice is published); it redefines wave 16's `factory_protected_view_check`
   (PRODUCT_SAFETY_INJURY: the ProductSafetyInjury, no employee) and wave 52's `factory_read_log_record_type_ok`
   (DataRequest), each word for word but for that; it calls recall's `factory_recall_words_ok`, `factory_recall_not_future`,
   `factory_recall_model_name_ok` and money's `factory_money_rome_day`):
   `…_cost_actuals_w2b_guards` (W2b-6 schema wave 54/57, B-W2b-376, actual cost to the end: the settings (a close tolerance of 0
   to 100, where the purchase price variance is taken, the company's switch for the accountant's figures GATE-ACCOUNTANT: only on a
   company's row, on with when and by whom; never deleted); work-order closes (the reason code exactly beyond the tolerance in force
   on garments, material cost, minutes or scrap; a live close only of a COMPLETED work order with no other live close, under the
   work order's costing lock; undone once: the Undo within 60 seconds by the person who closed it, a reopen later with why; an undone
   close frozen; written undone as history; at commit a live close's work order CLOSED at its time and an undone one's not
   (`WorkOrderClose_settled`, deferred); never deleted); the variance split append-only (a live close, the switch on, a material only
   for material price, usage and scrap); its own trigger `WorkOrderCostEntry_close_check` beside the W2a check (a CLOSED or settled
   work order takes no cost entry but a reversal; a VARIANCE entry is the opposite of its variance, before the CLOSE entry; the CLOSE
   entry leaves the work order's entries at 0; both dated at the close and only while the switch is on; reversed only once their
   close is undone) and `WorkOrder_close_reopen_check` (CLOSED → COMPLETED only with its close undone and the close's entries
   reversed); purchase price variances append-only (at the company's place, RECEIPT of a POSTED receipt line of ours for its whole
   base quantity or INVOICE of a GOODS line, the difference = quantity × (paid − standard) within one minor unit, reversed once);
   cost of goods sold append-only (one source: a shipment line of a shipment that left, for its garments, or a GOODS line of an
   issued invoice; the categories adding up; reversed once); landed cost DRAFT → POSTED (the shares adding up, the switch on, one
   POSTED per charge line: a partial unique) → REVERSED with why, of a CHARGE line for its net amount, only a DRAFT deleted, shares
   (`share:<allocation>:<lot>`) only while DRAFT on our received lots; every posting outside a HARD-locked period; it redefines W2b
   F40's `factory_work_order_guard` (CLOSED → COMPLETED, changing only the status, the closing time and the note), the rest word for
   word; it calls recall's `factory_recall_words_ok`, `factory_recall_not_future` and money's `factory_money_rome_day`,
   `factory_period_refuse_locked`):
   triggers, partial unique indexes and deferred
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
- A role's access may list `writeOnlyColumns` (B-W2b-363): columns it inserts or updates but never reads back (left out of
  its SELECT grant only, e.g. the partner's `SupplierBankAccount.iban`); a statement of that role naming one in a WHERE or
  RETURNING is refused, so its code selects the other columns only.
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
