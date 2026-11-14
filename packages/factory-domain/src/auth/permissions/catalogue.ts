import { CALENDARS_DEFINITIONS, CALENDARS_PERMISSIONS } from '../../calendars/permissions'
// B-W2a-18: the reason lists (reasons.view, reasons.manage).
import { REASONS_DEFINITIONS, REASONS_PERMISSIONS } from '../../reasons/permissions'
import { CERTIFICATES_PERMISSIONS } from '../../compliance/certificates/permissions'
import { REGISTER_PERMISSIONS } from '../../compliance/register/permissions'
import { COSTING_DEFINITIONS, COSTING_PERMISSIONS } from '../../costing/permissions'
import { FLOOR_SYNC_DEFINITIONS, FLOOR_SYNC_PERMISSIONS } from '../../floor-sync/permissions'
import { HOME_DEFINITIONS, HOME_PERMISSIONS } from '../../insights/permissions'
// B-W2a-79: the report library (home.reports.view).
import { HOME_REPORTS_DEFINITIONS, HOME_REPORTS_PERMISSIONS } from '../../insights/reports/permissions'
import { TASKS_DEFINITIONS, TASKS_PERMISSIONS } from '../../tasks/permissions'
// B-W2a-33: exception rules and stored alerts.
import { ALERTS_DEFINITIONS, ALERTS_PERMISSIONS } from '../../alerts/permissions'
import type { Permission } from '../../core/permissions'
import { INVENTORY_FLOOR_PERMISSIONS, INVENTORY_PERMISSIONS } from '../../inventory/permissions'
import { INVENTORY_COUNTS_DEFINITIONS, INVENTORY_COUNTS_PERMISSIONS } from '../../inventory/counts/permissions'
// B-W2a-31: receiving every day (discrepancies and the report to the supplier).
import { INVENTORY_DISCREPANCIES_DEFINITIONS, INVENTORY_DISCREPANCIES_PERMISSIONS } from '../../inventory/receipts/permissions'
import { INVENTORY_RESERVATION_PERMISSIONS } from '../../inventory/reservations/permissions'
// B-W2b-94: hides as stock (inventory.hides.manage: a hide's grade, shade group, thickness and defects; its re-measure).
import { INVENTORY_HIDES_DEFINITIONS, INVENTORY_HIDES_PERMISSIONS } from '../../inventory/hides/permissions'
// B-W2b-100: one shade lot per order (inventory.shade.override: a hide of another shade lot let through with the reason).
import { INVENTORY_SHADE_DEFINITIONS, INVENTORY_SHADE_PERMISSIONS } from '../../inventory/reservations/permissions'
// B-W2b-326: transfers between sites (inventory.transfers.manage).
import { INVENTORY_TRANSFERS_DEFINITIONS, INVENTORY_TRANSFERS_PERMISSIONS } from '../../inventory/transfers/permissions'
import { INVOICES_DEFINITIONS, INVOICES_PERMISSIONS } from '../../invoicing/permissions'
import { LINK_SESSION_PERMISSIONS as LINK_SESSION_NAMES, LINKS_OFFICE_PERMISSIONS } from '../../links/permissions'
import { NUMBERING_MANAGE, NUMBERING_VIEW } from '../../numbering/permissions'
// B-W2b-24: the controlled override of a migrated document's number (PLT-125).
import { NUMBERING_OVERRIDE_DEFINITIONS, NUMBERING_OVERRIDE_PERMISSIONS } from '../../numbering/permissions'
import { PARTIES_DEFINITIONS, PARTIES_PERMISSIONS } from '../../parties/permissions'
// B-W2b-162: partner organisations (partners.*, the office's) and the portal's own (portal.*, partner roles only).
import { PARTNERS_DEFINITIONS, PARTNERS_PERMISSIONS, PORTAL_DEFINITIONS, PORTAL_PERMISSIONS } from '../partners/permissions'
// B-W2b-167: the partner's Home (tasks, notifications, live; partner roles only) and the office's requests to partners.
import { PARTNER_TASKS_DEFINITIONS, PARTNER_TASKS_PERMISSIONS, PORTAL_HOME_DEFINITIONS, PORTAL_HOME_PERMISSIONS } from '../../portal/tasks/permissions'
// B-W2b-175: customer orders in the portal (portal.salesOrders.view; partner roles only).
import { PORTAL_SALES_ORDERS_DEFINITIONS, PORTAL_SALES_ORDERS_PERMISSIONS } from '../../sales/portal-orders/permissions'
// B-W2b-174: supplier orders in the portal (portal.purchaseOrders.view; partner roles only).
import { PORTAL_PURCHASE_ORDERS_DEFINITIONS, PORTAL_PURCHASE_ORDERS_PERMISSIONS } from '../../purchasing/portal-orders/permissions'
// B-W2b-178: customer documents in the portal (portal.customerDocuments.*; partner roles only).
import { PORTAL_CUSTOMER_DOCUMENTS_DEFINITIONS, PORTAL_CUSTOMER_DOCUMENTS_PERMISSIONS } from '../../sales/portal-documents/permissions'
// B-W2b-190: portal ordering (catalogue, order requests, delivery addresses; partner roles only).
import { PORTAL_ORDERING_DEFINITIONS, PORTAL_ORDERING_PERMISSIONS } from '../../sales/portal-ordering/permissions'
// B-W2b-183: change and cancel requests from the portal (partner roles only).
import { PORTAL_ORDER_CHANGES_DEFINITIONS, PORTAL_ORDER_CHANGES_PERMISSIONS } from '../../sales/change-requests/permissions'
// B-W2b-182: ship notices in the portal (portal.shipNotices.view; partner roles only).
import { PORTAL_SHIP_NOTICES_DEFINITIONS, PORTAL_SHIP_NOTICES_PERMISSIONS } from '../../purchasing/ship-notices/permissions'
// B-W2b-189: supplier documents and profile in the portal (partner) and their check (office).
import { PORTAL_SUPPLIER_PROFILE_DEFINITIONS, PORTAL_SUPPLIER_PROFILE_PERMISSIONS, SUPPLIER_REVIEW_DEFINITIONS, SUPPLIER_REVIEW_PERMISSIONS } from '../../purchasing/portal-profile/permissions'
import { PAYMENTS_DEFINITIONS, PAYMENTS_PERMISSIONS } from '../../payments/permissions'
import { PLANNING_DEFINITIONS, PLANNING_PERMISSIONS } from '../../planning/permissions'
import { PLANNING_SETTINGS_DEFINITIONS, PLANNING_SETTINGS_PERMISSIONS } from '../../planning/settings/permissions'
// B-W2a-22: MRP every day (planning.firm, planning.exceptions.manage).
import { PLANNING_EXCEPTIONS_DEFINITIONS, PLANNING_EXCEPTIONS_PERMISSIONS } from '../../planning/exceptions/permissions'
import { PLANNING_FIRM_DEFINITIONS, PLANNING_FIRM_PERMISSIONS } from '../../planning/mrp/permissions'
// B-W2a-34: the planning board (planning.schedule.manage, planning.schedule.publish).
import { PLANNING_SCHEDULE_DEFINITIONS, PLANNING_SCHEDULE_PERMISSIONS } from '../../planning/schedule/permissions'
// B-W2b-132: the leather and cut plan (planning.leather.manage).
import { PLANNING_LEATHER_DEFINITIONS, PLANNING_LEATHER_PERMISSIONS } from '../../planning/leather/permissions'
import { PURCHASING_DEFINITIONS, PURCHASING_PERMISSIONS } from '../../purchasing/permissions'
import { PURCHASING_SOURCES_DEFINITIONS, PURCHASING_SOURCES_PERMISSIONS } from '../../purchasing/sources/permissions'
// B-W2a-25: subcontracting (purchasing.subcontract.manage | kit | receive).
import { PURCHASING_SUBCONTRACT_DEFINITIONS, PURCHASING_SUBCONTRACT_PERMISSIONS } from '../../purchasing/subcontracting/permissions'
// B-W2a-76: the floor's share of subcontracting.
import { PURCHASING_SUBCONTRACT_FLOOR_PERMISSIONS } from '../../purchasing/subcontracting/permissions'
// B-W2a-44: supplier claims and returns to the supplier (purchasing.claims.manage | return).
import { PURCHASING_CLAIMS_DEFINITIONS, PURCHASING_CLAIMS_PERMISSIONS } from '../../purchasing/claims/permissions'
// B-W2b-14: the Owner's switch for automatic PO confirmation reminders (purchasing.reminders.switch, step-up).
import { PURCHASING_REMINDERS_DEFINITIONS, PURCHASING_REMINDERS_PERMISSIONS } from '../../purchasing/reminders/permissions'
// B-W2b-46: checks before a scan counts (the team leader's override on the tablet).
import { PRODUCTION_GUARDS_DEFINITIONS, PRODUCTION_GUARDS_FLOOR_PERMISSIONS, PRODUCTION_GUARDS_PERMISSIONS } from '../../production/guards/permissions'
// B-W2b-47: more on the tablet (scan on behalf, an unplanned operation).
import { PRODUCTION_ONBEHALF_DEFINITIONS, PRODUCTION_ONBEHALF_FLOOR_PERMISSIONS, PRODUCTION_ONBEHALF_PERMISSIONS } from '../../production/onbehalf/permissions'
import { PRODUCTION_EXTRAOPS_DEFINITIONS, PRODUCTION_EXTRAOPS_FLOOR_PERMISSIONS, PRODUCTION_EXTRAOPS_PERMISSIONS } from '../../production/extraops/permissions'
import { QUALITY_FINAL_DEFINITIONS, QUALITY_FINAL_FLOOR_PERMISSIONS, QUALITY_FINAL_PERMISSIONS } from '../../quality/final/permissions'
import { QUALITY_LAB_DEFINITIONS, QUALITY_LAB_PERMISSIONS } from '../../quality/lab/permissions'
// B-W2a-26: the defect library and disposition codes (quality.defects.*), quality holds (quality.holds.*).
import { QUALITY_DEFECTS_DEFINITIONS, QUALITY_DEFECTS_PERMISSIONS } from '../../quality/defects/permissions'
import { QUALITY_HOLDS_DEFINITIONS, QUALITY_HOLDS_PERMISSIONS } from '../../quality/holds/permissions'
// B-W2a-47: nonconformances.
import { QUALITY_NCR_DEFINITIONS, QUALITY_NCR_PERMISSIONS } from '../../quality/ncr/permissions'
import { PRODUCT_BOM_DEFINITIONS, PRODUCT_BOM_PERMISSIONS } from '../../product/bom/permissions'
import { PRODUCT_MATERIALS_DEFINITIONS, PRODUCT_MATERIALS_PERMISSIONS } from '../../product/materials/permissions'
import { PRODUCT_ROUTING_DEFINITIONS, PRODUCT_ROUTING_PERMISSIONS } from '../../product/routing/permissions'
import { PRODUCT_STYLES_DEFINITIONS, PRODUCT_STYLES_PERMISSIONS } from '../../product/styles/permissions'
import { SHIPPING_LABELS_DEFINITIONS, SHIPPING_LABELS_PERMISSIONS } from '../../shipping/labels/permissions'
import { WORKORDERS_DEFINITIONS, WORKORDERS_PERMISSIONS } from '../../production/work-orders/permissions'
import { PRIVACY_DEFINITIONS, PRIVACY_PERMISSIONS } from '../../privacy/permissions'
import { PRODUCTION_SETTINGS_DEFINITIONS, PRODUCTION_SETTINGS_PERMISSIONS } from '../../production/settings/permissions'
import { PRODUCTION_CUTTING_DEFINITIONS, PRODUCTION_CUTTING_FLOOR_PERMISSIONS, PRODUCTION_CUTTING_PERMISSIONS } from '../../production/cutting/permissions'
import { PRODUCTION_BUNDLES_DEFINITIONS, PRODUCTION_BUNDLES_FLOOR_PERMISSIONS, PRODUCTION_BUNDLES_PERMISSIONS } from '../../production/bundles/permissions'
import { PRODUCTION_SCANS_DEFINITIONS, PRODUCTION_SCANS_FLOOR_PERMISSIONS, PRODUCTION_SCANS_PERMISSIONS } from '../../production/scans/permissions'
import { PRODUCTION_SERIALS_DEFINITIONS, PRODUCTION_SERIALS_FLOOR_PERMISSIONS, PRODUCTION_SERIALS_PERMISSIONS } from '../../production/serials/permissions'
// B-W2a-12: report finished to stock (production.finish).
import { PRODUCTION_COMPLETION_DEFINITIONS, PRODUCTION_COMPLETION_PERMISSIONS } from '../../production/completion/permissions'
// W2a B-W2a-13: rework, scrap and replacements.
import { PRODUCTION_REWORK_DEFINITIONS, PRODUCTION_REWORK_FLOOR_PERMISSIONS, PRODUCTION_REWORK_PERMISSIONS } from '../../production/rework/permissions'
import { PRODUCTION_SCRAP_DEFINITIONS, PRODUCTION_SCRAP_PERMISSIONS } from '../../production/scrap/permissions'
import { COMPANY_BANK_DEFINITIONS, COMPANY_BANK_PERMISSIONS } from '../../sales/deposits/permissions'
import { ORDERS_DEFINITIONS, ORDERS_PERMISSIONS } from '../../sales/orders/permissions'
import { QUOTES_DEFINITIONS, QUOTES_PERMISSIONS, SALES_SETTINGS_DEFINITIONS, SALES_SETTINGS_PERMISSIONS } from '../../sales/quotes/permissions'
import { SHIPPING_DEFINITIONS, SHIPPING_FLOOR_PERMISSIONS, SHIPPING_PERMISSIONS } from '../../shipping/permissions'
// B-W2a-19: the payment terms library and the customer price lists.
import { PAYMENT_TERMS_DEFINITIONS, PAYMENT_TERMS_PERMISSIONS } from '../../sales/terms/permissions'
import { PRICE_LISTS_DEFINITIONS, PRICE_LISTS_PERMISSIONS } from '../../sales/pricelists/permissions'
// B-W2a-23: saved views and the export of any list (views.save, views.manage, views.export).
import { VIEWS_DEFINITIONS, VIEWS_PERMISSIONS } from '../../views/permissions'
// B-W2a-32: global search (search.rebuild; searching itself needs no permission of its own).
import { SEARCH_DEFINITIONS, SEARCH_PERMISSIONS } from '../../search/permissions'
// B-W2b-168: portal search (partner roles only).
import { PORTAL_SEARCH_DEFINITIONS, PORTAL_SEARCH_PERMISSIONS } from '../../search/partner/permissions'
// B-W2b-185: paying in the customer portal (partner roles only: open items, statement, pay by card or SEPA).
import { PORTAL_PAYMENTS_DEFINITIONS, PORTAL_PAYMENTS_PERMISSIONS } from '../../payments/online/permissions'
// B-W2b-176: subcontractor jobs in the portal (portal.jobs.view; partner roles only).
import { PORTAL_JOBS_DEFINITIONS, PORTAL_JOBS_PERMISSIONS } from '../../purchasing/portal-jobs/permissions'
// B-W2b-192: returns and complaints from outside (portal.returns.*, portal.complaints.view; partner roles only).
import { PORTAL_RETURNS_DEFINITIONS, PORTAL_RETURNS_PERMISSIONS } from '../../sales/portal-returns/permissions'
// B-W2b-184: approval requests to partners (partners.approvals.*, the office's; portal.approvals.view, partner roles only).
import { PARTNERS_APPROVALS_DEFINITIONS, PARTNERS_APPROVALS_PERMISSIONS, PORTAL_APPROVALS_DEFINITIONS, PORTAL_APPROVALS_PERMISSIONS } from '../../approvals-out/permissions'
// B-W2b-171: measurements by link (sales.measurements.view | manage).
import { SALES_MEASUREMENTS_DEFINITIONS, SALES_MEASUREMENTS_PERMISSIONS } from '../../sales/measure-link/permissions'
// B-W2b-200: inviting a partner to one record (partners.shares.view | manage, the office's).
import { PARTNERS_SHARES_DEFINITIONS, PARTNERS_SHARES_PERMISSIONS } from '../../shares/permissions'
// B-W2b-112: cut orders and cut tickets (production.cutorders.manage; reading is production.cutting.view, the table's scans production.cut).
import { PRODUCTION_CUTORDERS_DEFINITIONS, PRODUCTION_CUTORDERS_PERMISSIONS } from '../../production/cutorders/permissions'
// B-W2b-215: SMV governance (product.smv.propose, product.smv.approve).
import { PRODUCT_SMV_DEFINITIONS, PRODUCT_SMV_PERMISSIONS } from '../../product/minutes/permissions'
// B-W2b-117: after the cut (production.recuts, production.secondary, production.trolleys; shared with the floor).
import { PRODUCTION_CUTISSUE_DEFINITIONS, PRODUCTION_CUTISSUE_FLOOR_PERMISSIONS, PRODUCTION_CUTISSUE_PERMISSIONS } from '../../production/cutissue/permissions'
// B-W2b-172: the supplier questionnaire (purchasing.questionnaire.view | send | review | manage).
import { QUESTIONNAIRE_DEFINITIONS, QUESTIONNAIRE_PERMISSIONS } from '../../purchasing/questionnaire/permissions'
// B-W2b-208: the textile, leather and origin checks (compliance.textileRules.manage; reading is compliance.certificates.view).
import { TEXTILE_RULES_DEFINITIONS, TEXTILE_RULES_PERMISSIONS } from '../../compliance/textile-rules/permissions'
// B-W2b-214: work instructions.
import { PRODUCTION_INSTRUCTIONS_DEFINITIONS, PRODUCTION_INSTRUCTIONS_PERMISSIONS } from '../../production/instructions/permissions'
// B-W2b-221: the style lifecycle and the product settings (product.styles.lifecycle, product.settings.manage).
import { PRODUCT_LIFECYCLE_DEFINITIONS, PRODUCT_LIFECYCLE_PERMISSIONS } from '../../product/lifecycle/permissions'
// B-W2b-227: GTINs from the company's own GS1 range (product.gtins.manage).
import { PRODUCT_GTINS_DEFINITIONS, PRODUCT_GTINS_PERMISSIONS } from '../../product/gtin/permissions'
// B-W2b-226: change requests and change orders (product.changes.view | request | manage | approve).
import { PRODUCT_CHANGES_DEFINITIONS, PRODUCT_CHANGES_PERMISSIONS } from '../../product/changes/permissions'
// B-W2b-229: the option library (product.options.manage) and option prices (product.options.price).
import { PRODUCT_OPTIONS_DEFINITIONS, PRODUCT_OPTIONS_PERMISSIONS } from '../../product/options/permissions'
// B-W2b-238: materials in depth (product.materials.approve).
import { PRODUCT_MATERIALS_DEPTH_DEFINITIONS, PRODUCT_MATERIALS_DEPTH_PERMISSIONS } from '../../product/materials-depth/permissions'
// B-W2b-249: Rules & markets (compliance.rules.manage) and the phrase library (compliance.phrases.manage | approve); reading is compliance.certificates.view.
import { RULES_LIBRARY_DEFINITIONS, RULES_LIBRARY_PERMISSIONS } from '../../compliance/register-of-rules/permissions'
import { PHRASES_DEFINITIONS, PHRASES_PERMISSIONS } from '../../compliance/phrases/permissions'
// B-W2b-254: requirements and gates (compliance.requirements.manage, compliance.gates.override); reading is compliance.certificates.view.
import { REQUIREMENTS_DEFINITIONS, REQUIREMENTS_PERMISSIONS } from '../../compliance/requirements/permissions'
// B-W2b-230: the tech pack PDF per audience (product.techpacks.make).
import { PRODUCT_TECHPACKS_DEFINITIONS, PRODUCT_TECHPACKS_PERMISSIONS } from '../../product/techpack/permissions'
// B-W2b-233: prepacks (product.prepacks.manage; reading is product.styles.view).
import { PRODUCT_PREPACKS_DEFINITIONS, PRODUCT_PREPACKS_PERMISSIONS } from '../../product/prepacks/permissions'
// B-W2b-250: restricted substances and their rules (compliance.substances.manage); reading is compliance.certificates.view.
import { SUBSTANCES_DEFINITIONS, SUBSTANCES_PERMISSIONS } from '../../compliance/substances/permissions'
// B-W2b-246: sample rounds (sales.samples.view | manage).
import { SALES_SAMPLES_DEFINITIONS, SALES_SAMPLES_PERMISSIONS } from '../../sales/samples/permissions'
// B-W2b-251: technical files (compliance.techfiles.manage | sign | share); reading is compliance.certificates.view.
import { TECHFILES_DEFINITIONS, TECHFILES_PERMISSIONS } from '../../compliance/techfiles/permissions'
// B-W2b-257: the DoC generator (compliance.declarations.generate | check | pack); reading is compliance.certificates.view.
import { DECLARATIONS_DEFINITIONS, DECLARATIONS_PERMISSIONS } from '../../compliance/declarations/permissions'
// B-W2b-252: sample decisions (sales.samples.decide | measure); reading is sales.samples.view.
import { SALES_SAMPLE_DECISIONS_DEFINITIONS, SALES_SAMPLE_DECISIONS_PERMISSIONS } from '../../sales/sample-decisions/permissions'
// B-W2b-260: recall, withdrawal and authority (compliance.recall.manage | send); reading is compliance.register.view.
import { RECALL_DEFINITIONS, RECALL_PERMISSIONS } from '../../compliance/recall/permissions'
// B-W2b-258: the user information builder (compliance.userInformation.generate | check); reading is compliance.certificates.view.
import { USER_INFORMATION_DEFINITIONS, USER_INFORMATION_PERMISSIONS } from '../../compliance/user-information/permissions'
// B-W2b-256: supplier declarations (compliance.supplierDeclarations.manage); reading is compliance.certificates.view.
import { SUPPLIER_DECLARATIONS_DEFINITIONS, SUPPLIER_DECLARATIONS_PERMISSIONS } from '../../compliance/declarations-asked/permissions'
// B-W2b-259: label artwork approved by a second person (compliance.artwork.approve); the rest is labels.manage, bom, serials.
import { LABEL_ARTWORK_DEFINITIONS, LABEL_ARTWORK_PERMISSIONS } from '../../compliance/label-artwork/permissions'
// B-W2b-272: compliance reports (compliance.reports.view); each figure also needs its records' own view permission.
import { COMPLIANCE_REPORTS_DEFINITIONS, COMPLIANCE_REPORTS_PERMISSIONS } from '../../compliance/reports/permissions'
// B-W2b-263: Time & action (pre-production gates).
import { PLANNING_MILESTONES_DEFINITIONS, PLANNING_MILESTONES_PERMISSIONS } from '../../planning/milestones/permissions'
// B-W2b-248: made-to-measure rules (product.mtm.switch, the Owner's; reading and keeping them is product.styles.view | manage).
import { PRODUCT_MTM_DEFINITIONS, PRODUCT_MTM_PERMISSIONS } from '../../product/mtm-rules/permissions'
// B-W2b-264: sourcing & claims (compliance.claims.manage | approve); reading is compliance.certificates.view.
import { CLAIMS_DEFINITIONS, CLAIMS_PERMISSIONS } from '../../compliance/claims/permissions'
// B-W2b-262: the brand's samples and tech packs in the portal (portal.samples.view, partner).
import { PORTAL_SAMPLES_DEFINITIONS, PORTAL_SAMPLES_PERMISSIONS } from '../../sales/portal-samples/permissions'
// B-W2b-247: the colour library (product.colours.manage) and the brands' branding sets (product.branding.manage).
import { PRODUCT_COLOURS_DEFINITIONS, PRODUCT_COLOURS_PERMISSIONS } from '../../product/colours/permissions'
import { PRODUCT_BRANDING_DEFINITIONS, PRODUCT_BRANDING_PERMISSIONS } from '../../product/branding-sets/permissions'
// B-W2b-282: one approval engine (approvals.view | request | decide | rules.manage).
import { APPROVALS_DEFINITIONS, APPROVALS_PERMISSIONS } from '../../approvals/permissions'
// B-W2b-296: purchase orders in depth (purchasing.tolerances.manage: the delivery tolerances).
import { PO_DEPTH_DEFINITIONS, PO_DEPTH_PERMISSIONS } from '../../purchasing/po-depth/permissions'
// B-W2b-332: ask to buy (purchasing.requests.ask).
import { ASK_TO_BUY_DEFINITIONS, ASK_TO_BUY_PERMISSIONS } from '../../purchasing/ask-to-buy/permissions'
// B-W2b-288: the PPE text approvals (compliance.ppeTexts.manage, the owner's); reading is compliance.certificates.view.
import { PPE_TEXTS_DEFINITIONS, PPE_TEXTS_PERMISSIONS } from '../../compliance/ppe-texts/permissions'
// B-W2b-313: lots in depth (inventory.lots.manage: split into shade groups, regroup, attributes; inventory.trace.report).
import { INVENTORY_LOTS_DEPTH_DEFINITIONS, INVENTORY_LOTS_DEPTH_PERMISSIONS } from '../../inventory/lots-depth/permissions'
// B-W2b-290: customers in depth (parties.hold; parties.privacy, parties.erase; area `parties`).
import { PARTIES_HOLD_DEFINITIONS, PARTIES_HOLD_PERMISSIONS } from '../../parties/holds/permissions'
import { PARTIES_PRIVACY_DEFINITIONS, PARTIES_PRIVACY_PERMISSIONS } from '../../parties/contact-privacy/permissions'
// B-W2b-295: inquiries and requests for quotation (sales.inquiries.view | manage).
import { SALES_INQUIRIES_DEFINITIONS, SALES_INQUIRIES_PERMISSIONS } from '../../sales/inquiries/permissions'
// B-W2b-314: the warehouse rules (inventory.rules.manage).
import { INVENTORY_RULES_DEFINITIONS, INVENTORY_RULES_PERMISSIONS } from '../../inventory/posting/permissions'
// B-W2b-293: planned work and subcontract orders made real (planning.planned.convert).
import { PLANNING_PLANNED_DEFINITIONS, PLANNING_PLANNED_PERMISSIONS } from '../../planning/planned-orders/permissions'
// B-W2b-301: promise dates (planning.promise.view, planning.promise.manage).
import { PLANNING_PROMISE_DEFINITIONS, PLANNING_PROMISE_PERMISSIONS } from '../../planning/promise/permissions'
// B-W2b-312: scheduling in depth (planning.schedule.pin).
import { PLANNING_SCHEDULE_DEPTH_DEFINITIONS, PLANNING_SCHEDULE_DEPTH_PERMISSIONS } from '../../planning/schedule-depth/permissions'
// B-W2b-317: the backlog ranked (planning.backlog.manage).
import { PLANNING_BACKLOG_DEFINITIONS, PLANNING_BACKLOG_PERMISSIONS } from '../../planning/backlog/permissions'
// B-W2b-321: work to subcontractors.
import { PLANNING_SUBCONTRACT_DEFINITIONS, PLANNING_SUBCONTRACT_PERMISSIONS } from '../../planning/subcontract-capacity/permissions'
// B-W2b-311: suppliers in depth (purchasing.suppliers.status).
import { SUPPLIERS_DEPTH_DEFINITIONS, SUPPLIERS_DEPTH_PERMISSIONS } from '../../purchasing/suppliers-depth/permissions'
// B-W2b-292: the warehouse task inbox (inventory.tasks.manage: tasks by hand, handed out, changed, cancelled).
import { INVENTORY_TASKS_DEFINITIONS, INVENTORY_TASKS_PERMISSIONS } from '../../inventory/tasks/permissions'
// B-W2b-331: subcontracting in depth (purchasing.subcontract.terms | balance | cost).
import { SUBCONTRACT_DEPTH_DEFINITIONS, SUBCONTRACT_DEPTH_PERMISSIONS } from '../../purchasing/subcontract-depth/permissions'
// B-W2b-356: warehouse reports (inventory.reports.view: stock ageing and leather use; each figure also inventory.stock.view).
import { INVENTORY_REPORTS_DEFINITIONS, INVENTORY_REPORTS_PERMISSIONS } from '../../inventory/reports/permissions'
// B-W2b-300: goods without a PO (the buyer names the order or sends them back).
import { INVENTORY_UNPLANNED_DEFINITIONS, INVENTORY_UNPLANNED_PERMISSIONS } from '../../inventory/unplanned/permissions'
// B-W2b-315: supplier bank details with change control (purchasing.bank.*, portal.supplierBank.*), qualification and the PO's compliance gate.
import { BANK_DEFINITIONS, BANK_PERMISSIONS, PORTAL_BANK_DEFINITIONS, PORTAL_BANK_PERMISSIONS } from '../../purchasing/bank/permissions'
import { QUALIFICATION_DEFINITIONS, QUALIFICATION_PERMISSIONS } from '../../purchasing/qualification/permissions'
// B-W2b-319: the production strategy per item (planning.strategy.manage); the one demand view reads with planning.view.
import { PLANNING_STRATEGY_DEFINITIONS, PLANNING_STRATEGY_PERMISSIONS } from '../../planning/strategy/permissions'
// B-W2b-350: purchasing reports (purchasing.reports.view: spend and late lines; each figure also purchasing.view).
import { PURCHASING_REPORTS_DEFINITIONS, PURCHASING_REPORTS_PERMISSIONS } from '../../purchasing/reports/permissions'
// B-W2b-349: planning reports (planning.reports.view: adherence, utilisation, material cover; each figure also planning.view).
import { PLANNING_REPORTS_DEFINITIONS, PLANNING_REPORTS_PERMISSIONS } from '../../planning/reports/permissions'
// B-W2b-348: sales reports (sales.reports.view: intake, backlog by promise week, return reasons; each figure also the records' view).
import { SALES_REPORTS_DEFINITIONS, SALES_REPORTS_PERMISSIONS } from '../../insights/sales-reports/permissions'
// B-W2b-299: counts in depth (inventory.counts.scan: count by scanning every unit, shared with the floor).
import { INVENTORY_COUNTS_DEPTH_DEFINITIONS, INVENTORY_COUNTS_DEPTH_FLOOR_PERMISSIONS, INVENTORY_COUNTS_DEPTH_PERMISSIONS } from '../../inventory/counts-depth/permissions'
// B-W2b-294: quote templates (quotes.templates.manage); reading them is quotes.view, starting a quote from one quotes.manage.
import { QUOTE_TEMPLATES_DEFINITIONS, QUOTE_TEMPLATES_PERMISSIONS } from '../../sales/quote-templates/permissions'
// B-W2b-306: MRP you can trust (planning.actions.manage: action messages; planning.planned.edit: protected edits, bulk edit).
import { PLANNING_ACTIONS_DEFINITIONS, PLANNING_ACTIONS_PERMISSIONS } from '../../planning/actions/permissions'
// B-W2a-35: the plant (machines, machine requests, maintenance jobs).
import { PLANT_DEFINITIONS, PLANT_FLOOR_PERMISSIONS, PLANT_PERMISSIONS } from '../../plant/permissions'
// B-W2a-39: the accounting exports and the period locks (accounting.view | export | lock | unlock).
import { ACCOUNTING_DEFINITIONS, ACCOUNTING_PERMISSIONS } from '../../accounting/permissions'
// B-W2b-201: accountant access (portal.accounting.view, partner only; accounting.accountants.manage).
import { ACCOUNTANTS_DEFINITIONS, ACCOUNTANTS_PERMISSIONS, PORTAL_ACCOUNTING_DEFINITIONS, PORTAL_ACCOUNTING_PERMISSIONS } from '../../accounting/guest/permissions'
// B-W2a-36: Security & health (security.view, security.drills.record).
import { SECURITY_DEFINITIONS, SECURITY_PERMISSIONS } from '../../ops/permissions'
// B-W2a-43: customer returns (sales.returns.view | manage | receive | inspect | decide).
import { SALES_RETURNS_DEFINITIONS, SALES_RETURNS_FLOOR_PERMISSIONS, SALES_RETURNS_PERMISSIONS } from '../../sales/returns/permissions'
// B-W2a-38: production reports (the daily production report, its e-mail).
import { PRODUCTION_REPORTS_DEFINITIONS, PRODUCTION_REPORTS_PERMISSIONS } from '../../production/reports/permissions'
// B-W2a-41: the mail delivery log and the blocked addresses (email.delivery.view | unblock).
import { EMAIL_DELIVERY_DEFINITIONS, EMAIL_DELIVERY_PERMISSIONS } from '../../email-delivery/permissions'
// B-W2a-48: shipping every day (shipping.freight.manage, shipping.evidence.manage).
import { SHIPPING_DAILY_DEFINITIONS, SHIPPING_DAILY_PERMISSIONS } from '../../shipping/shipments/permissions'
// B-W2a-57: repairs and alterations (sales.repairs.view | manage | receive | check | ship).
import { SALES_REPAIRS_DEFINITIONS, SALES_REPAIRS_PERMISSIONS } from '../../sales/repairs/permissions'
// B-W2a-55: receivables (receivables.view | reminders.manage | reminders.approve | statements.send | settings.manage | reminders.switch).
import { RECEIVABLES_DEFINITIONS, RECEIVABLES_PERMISSIONS } from '../../receivables/permissions'
// B-W2a-62: payables (payables.view | manage | differences.accept | approve | pay).
import { PAYABLES_DEFINITIONS, PAYABLES_PERMISSIONS } from '../../payables/permissions'
// B-W2a-65: customer complaints (quality.complaints.view | log | manage | acknowledge).
import { QUALITY_COMPLAINTS_DEFINITIONS, QUALITY_COMPLAINTS_PERMISSIONS } from '../../quality/complaints/permissions'
// B-W2b-26: people (employees, teams and loans, leaver steps).
import { PEOPLE_EMPLOYEES_DEFINITIONS, PEOPLE_EMPLOYEES_PERMISSIONS } from '../../people/employees/permissions'
import { PEOPLE_TEAMS_DEFINITIONS, PEOPLE_TEAMS_PERMISSIONS } from '../../people/teams/permissions'
import { PEOPLE_LEAVERS_DEFINITIONS, PEOPLE_LEAVERS_PERMISSIONS } from '../../people/leavers/permissions'
// B-W2b-27: privacy of people data (people.privacy.view | manage, people.figures.view).
import { PEOPLE_PRIVACY_DEFINITIONS, PEOPLE_PRIVACY_PERMISSIONS } from '../../people/privacy/permissions'
// B-W2b-29: off-standard and indirect time (production.offstandard.view | codes | approve).
import { PRODUCTION_OFFSTANDARD_DEFINITIONS, PRODUCTION_OFFSTANDARD_PERMISSIONS } from '../../production/offstandard/permissions'
// B-W2b-35: help calls (production.calls.view | answer | manage).
import { PRODUCTION_CALLS_DEFINITIONS, PRODUCTION_CALLS_FLOOR_PERMISSIONS, PRODUCTION_CALLS_PERMISSIONS } from '../../production/calls/permissions'
// B-W2b-32: shifts and overtime requests (people.shifts.view | manage | team, people.overtime.manage | approve).
import { PEOPLE_SHIFTS_DEFINITIONS, PEOPLE_SHIFTS_PERMISSIONS } from '../../people/shifts/permissions'
// B-W2b-39: skills and machine authorisations (people.skills.view | manage, people.authorisations.manage).
import { PEOPLE_SKILLS_DEFINITIONS, PEOPLE_SKILLS_PERMISSIONS } from '../../people/skills/permissions'
// B-W2b-34: piece rates and the legal switch of piece pay (people.piecerates.view | manage | switch).
import { PEOPLE_PIECERATES_DEFINITIONS, PEOPLE_PIECERATES_PERMISSIONS } from '../../people/piecerates/permissions'
// B-W2b-33: clock in and out (people.attendance.view: the attendance read; clocking itself is the floor's).
import { PEOPLE_CLOCK_DEFINITIONS, PEOPLE_CLOCK_PERMISSIONS } from '../../people/clock/permissions'
// B-W2b-37: attendance days (people.attendance.manage | approve | settings | rollcall).
import { PEOPLE_ATTENDANCE_DEFINITIONS, PEOPLE_ATTENDANCE_PERMISSIONS } from '../../people/attendance/permissions'
// B-W2b-44: efficiency (people.efficiency.view | review).
import { PEOPLE_EFFICIENCY_DEFINITIONS, PEOPLE_EFFICIENCY_PERMISSIONS } from '../../people/efficiency/permissions'
// B-W2b-42: overtime worked and timesheets (people.overtime.review, people.timesheets.team | lead | hr), working-time limits.
import { PEOPLE_OVERTIME_DEFINITIONS, PEOPLE_OVERTIME_PERMISSIONS } from '../../people/overtime/permissions'
// B-W2b-48: the month close (people.attendance.close | correct | lul).
import { PEOPLE_CLOSE_DEFINITIONS, PEOPLE_CLOSE_PERMISSIONS } from '../../people/close/permissions'
import { PEOPLE_LIMITS_DEFINITIONS, PEOPLE_LIMITS_PERMISSIONS } from '../../people/limits/permissions'
// B-W2b-43: earnings and pay periods (people.earnings.view | records | manage | review).
import { PEOPLE_EARNINGS_DEFINITIONS, PEOPLE_EARNINGS_PERMISSIONS } from '../../people/earnings/permissions'
// B-W2b-54: the payroll export (people.payroll.view | records | manage).
import { PEOPLE_PAYROLL_DEFINITIONS, PEOPLE_PAYROLL_PERMISSIONS } from '../../people/payroll/permissions'
// B-W2b-45: labour records and corrections (production.labour.view | close | reopen | answer).
import { PRODUCTION_LABOUR_DEFINITIONS, PRODUCTION_LABOUR_PERMISSIONS } from '../../production/labour/permissions'
// B-W2b-50: line targets and boards (production.boards.view | targets | reason).
import { PRODUCTION_BOARDS_DEFINITIONS, PRODUCTION_BOARDS_FLOOR_PERMISSIONS, PRODUCTION_BOARDS_PERMISSIONS } from '../../production/boards/permissions'
// B-W2b-49: dispatch every shift (the board, assigning and moving work, handover notes).
import { PRODUCTION_DISPATCH_DEFINITIONS, PRODUCTION_DISPATCH_FLOOR_PERMISSIONS, PRODUCTION_DISPATCH_PERMISSIONS } from '../../production/dispatch/permissions'
// B-W2b-93: AQL profiles and the AQL calculator (quality.aql.view | manage).
import { QUALITY_AQL_DEFINITIONS, QUALITY_AQL_PERMISSIONS } from '../../quality/aql/permissions'
// B-W2b-92: inspection plans (quality.plans.view | manage | approve).
import { QUALITY_PLANS_DEFINITIONS, QUALITY_PLANS_PERMISSIONS } from '../../quality/plans/permissions'
// B-W2b-101: inspection triggers (quality.triggers.view | manage).
import { QUALITY_TRIGGERS_DEFINITIONS, QUALITY_TRIGGERS_PERMISSIONS } from '../../quality/triggers/permissions'
// B-W2b-98: the incoming inspection of a lot, hide by hide (quality.incoming.view | record).
import { QUALITY_INCOMING_DEFINITIONS, QUALITY_INCOMING_FLOOR_PERMISSIONS, QUALITY_INCOMING_PERMISSIONS } from '../../quality/incoming/permissions'
// B-W2b-99: in-process checks (quality.inprocess.view | record).
import { QUALITY_INPROCESS_DEFINITIONS, QUALITY_INPROCESS_FLOOR_PERMISSIONS, QUALITY_INPROCESS_PERMISSIONS } from '../../quality/inprocess/permissions'
// B-W2b-107: rolls, protector lots and consumables (inventory.rolls.manage; inventory.protectors.record, shared with the floor).
import { INVENTORY_ROLLS_DEFINITIONS, INVENTORY_ROLLS_FLOOR_PERMISSIONS, INVENTORY_ROLLS_PERMISSIONS } from '../../inventory/rolls/permissions'
// B-W2b-108: corrective actions, CAPA and 8D (quality.capa.view | manage).
import { QUALITY_CAPA_DEFINITIONS, QUALITY_CAPA_PERMISSIONS } from '../../quality/capa/permissions'
// B-W2b-124: statutory periodic checks of machines (plant.checks.manage).
import { PLANT_CHECKS_DEFINITIONS, PLANT_CHECKS_PERMISSIONS } from '../../plant/statutory/permissions'
// B-W2b-123: amendments of signed results (quality.amendments.request | sign) and the quality documents (quality.documents.make | share).
import { QUALITY_AMENDMENTS_DEFINITIONS, QUALITY_AMENDMENTS_PERMISSIONS } from '../../quality/amendments/permissions'
import { QUALITY_DOCUMENTS_DEFINITIONS, QUALITY_DOCUMENTS_PERMISSIONS } from '../../quality/inspection-docs/permissions'
// B-W2b-120: the safety organisation and the safety calendar (safety.view | organisation.manage | calendar.manage).
import { SAFETY_DEFINITIONS, SAFETY_PERMISSIONS } from '../../safety/organisation/permissions'
import { SAFETY_CALENDAR_DEFINITIONS, SAFETY_CALENDAR_PERMISSIONS } from '../../safety/calendar/permissions'
// B-W2b-118: quality rules (quality.rules.view; quality.alerts.manage).
import { QUALITY_RULES_DEFINITIONS, QUALITY_RULES_PERMISSIONS } from '../../quality/rules/permissions'
// B-W2b-126: the repair station and second quality (production.repair, shared with the floor; production.downgrade).
import { PRODUCTION_REPAIR_DEFINITIONS, PRODUCTION_REPAIR_FLOOR_PERMISSIONS, PRODUCTION_REPAIR_PERMISSIONS } from '../../production/repair/permissions'
// B-W2b-122: the risk assessment, the DVR (safety.risk.manage | sign).
import { SAFETY_RISK_DEFINITIONS, SAFETY_RISK_PERMISSIONS } from '../../safety/risk/permissions'
// B-W2b-125: incidents, near misses and hazards (safety.incidents.view | report | manage | people).
import { SAFETY_INCIDENTS_DEFINITIONS, SAFETY_INCIDENTS_PERMISSIONS } from '../../safety/incidents/permissions'
// B-W2b-138: quality reports (quality.reports.view).
import { QUALITY_REPORTS_DEFINITIONS, QUALITY_REPORTS_PERMISSIONS } from '../../quality/reports/permissions'
// B-W2b-128: role sheets (safety.rolesheets.manage: a role's risks, PPE kit, courses and whether it needs health surveillance).
import { SAFETY_ROLESHEETS_DEFINITIONS, SAFETY_ROLESHEETS_PERMISSIONS } from '../../safety/rolesheets/permissions'
// B-W2b-133: the course catalogue and who needs which course (safety.training.manage: courses, and what a machine type asks).
import { SAFETY_TRAINING_DEFINITIONS, SAFETY_TRAINING_PERMISSIONS } from '../../safety/training/permissions'
// B-W2b-134: PPE for workers (safety.ppe.manage: the catalogue; safety.ppe.issue: paper receipts and voids).
import { SAFETY_PPE_DEFINITIONS, SAFETY_PPE_PERMISSIONS } from '../../safety/ppe/permissions'
// B-W2b-143: the chemical register and the safety data sheets (safety.chemicals.manage).
import { SAFETY_CHEMICALS_DEFINITIONS, SAFETY_CHEMICALS_PERMISSIONS } from '../../safety/chemicals/permissions'
// B-W2b-135: health surveillance (safety.health.view | manage | plans | views: protected, every view recorded).
import { SAFETY_HEALTH_DEFINITIONS, SAFETY_HEALTH_PERMISSIONS } from '../../safety/health/permissions'
// B-W2b-139: training records (safety.training.record: sessions, attendance, records; safety.instruction.record: the instruction register).
import { SAFETY_RECORDS_DEFINITIONS, SAFETY_RECORDS_PERMISSIONS } from '../../safety/records/permissions'
// B-W2b-161: company branding (documents.branding.manage: logo, accent, sender name, portal label; step-up).
import { BRANDING_DEFINITIONS, BRANDING_PERMISSIONS } from '../../branding/permissions'
// B-W2b-177: required documents per record type before a status move (documents.required.manage).
import { REQUIRED_DOCUMENTS_DEFINITIONS, REQUIRED_DOCUMENTS_PERMISSIONS } from '../../files/required/permissions'
import { GRAIN_DESCRIPTIONS, GRAINS, grainPermission } from '../grains/grains'
import { definePermissions, permissionRegistry, type PermissionDefinition } from './registry'
// B-W2b-304: credit limits (sales.credit.view, .limits, .checks).
import { SALES_CREDIT_DEFINITIONS, SALES_CREDIT_PERMISSIONS } from '../../sales/credit/permissions'
// B-W2b-345: warranty and service cases (sales.service.view, .manage, .decide).
import { SALES_SERVICE_DEFINITIONS, SALES_SERVICE_PERMISSIONS } from '../../sales/service/permissions'
// B-W2b-351: product-safety reports and the accident log (sales.safety.view, .manage, .injury, .log).
import { SALES_SAFETY_DEFINITIONS, SALES_SAFETY_PERMISSIONS } from '../../sales/safety-reports/permissions'
// B-W2b-358: the made-to-measure office (record a revision, the factory review).
import { SALES_MTM_DEFINITIONS, SALES_MTM_PERMISSIONS } from '../../sales/mtm/permissions'
// B-W2b-360: fittings, alterations and remakes (book and record fittings).
import { SALES_FITTINGS_DEFINITIONS, SALES_FITTINGS_PERMISSIONS } from '../../sales/fittings/permissions'
// B-W2b-384: packing in depth (shipping.packaging.manage).
import { SHIPPING_PACKAGING_DEFINITIONS, SHIPPING_PACKAGING_PERMISSIONS } from '../../shipping/packaging/permissions'
// B-W2b-386: the shipment queue in depth (shipping.holds.manage, shipping.holds.release).
import { SHIPPING_HOLDS_DEFINITIONS, SHIPPING_HOLDS_PERMISSIONS } from '../../shipping/holds/permissions'
// B-W2b-391: labels and documents (shipping.proforma.issue).
import { SHIPPING_PROFORMA_DEFINITIONS, SHIPPING_PROFORMA_PERMISSIONS } from '../../shipping/proforma/permissions'
// B-W2b-385: notifications in depth (home.notifications.manage: the notification defaults of each office role).
import { NOTIFICATION_DEFAULTS_DEFINITIONS, NOTIFICATION_DEFAULTS_PERMISSIONS } from '../../notifications/preferences/permissions'
// B-W2b-389: currencies and exchange rates (currencies.view | manage).
import { CURRENCY_DEFINITIONS, CURRENCY_PERMISSIONS } from '../../money/currency/permissions'
// B-W2b-392: tax rules as data (invoices.tax.manage, invoices.tax.switch).
import { TAX_RULES_DEFINITIONS, TAX_RULES_PERMISSIONS } from '../../invoicing/tax-codes/permissions'
// B-W2b-393: bank statements, matching and write-offs (payments.bank.view | import | match, payments.writeOff).
import { PAYMENTS_BANK_DEFINITIONS, PAYMENTS_BANK_PERMISSIONS } from '../../payments/bank/permissions'
import { WRITE_OFF_DEFINITIONS, WRITE_OFF_PERMISSIONS } from '../../payments/write-offs/permissions'
// B-W2b-394: mail in depth (email.inboxes.manage: team inboxes and the capture address).
import { MAIL_DEPTH_DEFINITIONS, MAIL_DEPTH_PERMISSIONS } from '../../mail-depth/permissions'

/**
 * Every permission of the factory, assembled (feature PLT-029). A module that adds routes declares its permissions
 * with `definePermissions('<module>', {…})` in `factory-domain/src/<module>/permissions.ts` and adds its list to
 * FACTORY_PERMISSIONS here, in the same PR as the routes (the API refuses to boot on a manifest permission that is
 * not declared). It then gives the new permissions to the role templates that need them (`../roles/templates`).
 */

/** The tenant's people (apps/factory-api platform/auth/users and invitations). */
export const USERS_PERMISSIONS = definePermissions('users', {
  view: { risk: 'read', description: 'See the people of the tenant: status, two-factor, open invitations.' },
  invite: { risk: 'stepUp', description: 'Invite a person by email, with their first roles, and revoke an open invitation.' },
  suspend: { risk: 'stepUp', description: 'Suspend a person: every session ends at once.' },
  reactivate: { risk: 'stepUp', description: 'Give a suspended person their access back.' },
  deactivate: { risk: 'stepUp', description: 'Deactivate a person who left: credentials cleared, history kept.' },
  resetPassword: { risk: 'stepUp', description: 'Require a new password at the next sign-in.' },
})

/**
 * The tenancy core in the Office (apps/factory-api platform/admin/org; SCR-008, SCR-009; PLT-003, PLT-004, MES-292):
 * the companies with their legal and e-invoicing data, and the sites with their lines, work centres and stations.
 * Checked with can() against the company (and the site). Creating a company needs a grant over every company. Not
 * step-up: the bank account has its own (companies.bank.manage); every change is audited from → to.
 */
export const COMPANIES_DEFINITIONS = definePermissions('companies', {
  view: { risk: 'read', description: "See the companies: legal name, VAT and tax codes, PEC and SDI code, defaults, and whether they can issue invoices." },
  manage: { risk: 'write', description: "Add a company, change its legal, e-invoicing and default data, archive it when nothing uses it." },
})
export const SITES_DEFINITIONS = definePermissions('sites', {
  view: { risk: 'read', description: 'See the sites of the companies with their lines, work centres and stations.' },
  manage: { risk: 'write', description: 'Add and change sites, lines, work centres and stations; archive them when nothing active uses them.' },
})
export const COMPANIES_VIEW = 'companies.view' satisfies Permission
export const COMPANIES_MANAGE = 'companies.manage' satisfies Permission
export const SITES_VIEW = 'sites.view' satisfies Permission
export const SITES_MANAGE = 'sites.manage' satisfies Permission

/** Roles and their assignments (platform/auth/roles). */
export const ROLES_PERMISSIONS = definePermissions('roles', {
  view: { risk: 'read', description: 'See the role templates, the roles of the tenant and who holds them.' },
  manage: { risk: 'stepUp', description: 'Create and edit custom roles, and bring the system roles up to their templates.' },
  assign: { risk: 'stepUp', description: 'Give roles to people, limited to companies, sites or customers, and end them.' },
})

/** The audit log (platform/audit). */
export const AUDIT_PERMISSIONS = definePermissions('audit', {
  read: { risk: 'read', description: 'Read the history of a record (money values only with their grain).' },
})

/** Document numbering (platform/numbering; the constants live in factory-domain/src/numbering/permissions.ts). */
export const NUMBERING_DEFINITIONS = definePermissions('numbering', {
  view: { risk: 'read', description: "See the companies' number series and their next numbers." },
  manage: { risk: 'write', description: 'Create a number series, set where it starts, move it past a number.' },
})

/**
 * Files on R2 (apps/factory-api platform/files; plan A1 §3.6, COL-045, COL-050). Each is checked with can() against the
 * file's company, and for a floor, portal or link session against the site or party the file is shared with (that
 * audience's own rule decides what it sees; a role only grants the permission). Sharing beyond the office, retention
 * and legal hold are files.manage. Not step-up: A1 §3.10 keeps step-up for bank details, issuing invoices and user and
 * role changes; a retained or held file cannot be deleted by anyone (the database refuses it too).
 */
export const FILES_DEFINITIONS = definePermissions('files', {
  read: { risk: 'read', description: "See a record's files and download them (floor, portal and link sessions: only what is shared with them)." },
  upload: { risk: 'write', description: 'Upload a file to a record (seen by the office only, unless shared with files.manage).' },
  delete: { risk: 'write', description: 'Delete a file; never one on legal hold or before its retention date.' },
  manage: { risk: 'write', description: 'Share a file with a floor, a portal or links; set its retention date and legal hold.' },
})
export const FILES_READ = 'files.read' satisfies Permission
export const FILES_UPLOAD = 'files.upload' satisfies Permission
export const FILES_DELETE = 'files.delete' satisfies Permission
export const FILES_MANAGE = 'files.manage' satisfies Permission

/** One-off links, office side (platform/links): make, revoke and follow the links of a record. */
export const LINKS_PERMISSIONS = definePermissions('links', {
  view: { risk: 'read', description: 'See the one-off links of a record: whom they were made for, their state, their uses and the evidence of each answer.' },
  manage: { risk: 'write', description: 'Make a one-off link for a record, to send to its customer or supplier, and revoke one.' },
})

/**
 * What a one-off link session may do (platform/links). Held only by link sessions, from the link's purpose
 * (factory-domain links/purposes): never assignable to a role.
 */
export const LINK_SESSION_PERMISSIONS: PermissionDefinition[] = definePermissions('links', {
  open: { risk: 'read', description: "Open the link's one record (its own prices only when the purpose shows its own document)." },
  accept: { risk: 'write', description: 'Accept the quote the link opens, with a typed name (and the address it was sent to, when known).' },
  decline: { risk: 'write', description: 'Decline the quote or purchase order the link opens.' },
  confirm: { risk: 'write', description: 'Confirm the purchase order the link opens.' },
  // B-W2b-163: the actions of W2b-3's link purposes.
  download: { risk: 'read', description: "Download one of the link's files (a document or a secure file); every download is logged." },
  receive: { risk: 'write', description: 'Confirm "I received these files" on a secure file link, once, with an optional typed name.' },
  submit: { risk: 'write', description: "Send the link's form: the measurements, the claim or the supplier questionnaire." },
  approve: { risk: 'write', description: 'Approve the request the link opens, with or without changes, with a typed name.' },
  refuse: { risk: 'write', description: 'Refuse the request the link opens, with a typed name and the reason.' },
  pay: { risk: 'write', description: 'Pay its own deposit request or invoice the link opens, online.' },
  moveDate: { risk: 'write', description: 'Propose another date for the subcontract job the link opens.' },
  post: { risk: 'write', description: 'Post a message on the record shared with the link, when the share allows comments.' },
  upload: { risk: 'write', description: 'Upload a file to the record shared with the link, when the share allows uploads.' },
}).map((definition) => Object.freeze({ ...definition, link: true as const }))

/** The floor devices of the sites (apps/factory-api platform/auth/floor; features PLT-056, PLT-226). */
export const DEVICES_PERMISSIONS = definePermissions('devices', {
  view: { risk: 'read', description: 'See the floor devices of the sites: station, status, last contact, whether someone is signed in.' },
  manage: { risk: 'write', description: 'Enrol a floor device with a one-time QR code, rename it, move it to a station, set the floor session times of a site.' },
  revoke: { risk: 'write', description: 'Revoke a lost or retired floor device: its sign-ins end at once.' },
})

/** The floor workers of the sites, kept to what the work needs (features PLT-018, PLT-019; GDPR art. 5(1)(c)). */
export const WORKERS_PERMISSIONS = definePermissions('workers', {
  view: { risk: 'read', description: 'See the floor workers of the sites: name, language, badges, floor roles.' },
  manage: { risk: 'write', description: 'Add a floor worker, edit their name and language, deactivate and reactivate them.' },
  roles: { risk: 'stepUp', description: "Give and end a floor worker's floor roles (what their floor sessions may do)." },
  credentials: { risk: 'stepUp', description: "Issue and revoke a worker's badge, and reset their PIN." },
})

/**
 * What floor sessions do (audience floor: only floor roles hold them). The floor modules add theirs (scans, cut
 * logs, inspections) and give them to the floor templates.
 */
export const FLOOR_PERMISSIONS = definePermissions('floor', {
  work: { risk: 'write', description: "Work on an enrolled floor device: the work screens of the device's site." },
  lead: { risk: 'write', description: "Lead a crew on the floor: the team leader's screens of the device's site." },
})

/**
 * Record threads and the record timeline (apps/factory-api platform/threads; plan A1 §2.3, §3.7; COL-001, COL-002,
 * COL-003). Each is checked with can() against the record's company and site (a portal or link session: its party, and
 * a link only its own record). threads.read opens a record's thread and timeline (the timeline's field values also need
 * audit.read); threads.post writes internal notes; threads.manage closes and reopens a thread.
 */
export const THREADS_DEFINITIONS = definePermissions('threads', {
  read: { risk: 'read', description: "See a record's thread and timeline (portal and link sessions: only the messages shared with them)." },
  post: { risk: 'write', description: "Write internal notes on a record's thread, mention colleagues and attach the record's files." },
  manage: { risk: 'write', description: "Close a record's thread to new notes, and reopen it." },
})
export const THREADS_READ = 'threads.read' satisfies Permission
export const THREADS_POST = 'threads.post' satisfies Permission
export const THREADS_MANAGE = 'threads.manage' satisfies Permission
/**
 * Imports with a dry run (apps/factory-api platform/imports; plan A1 W0-22, feature PLT-176). Each is checked with can()
 * against the job's company. An importer also names the permissions of the records it writes (its adapter's
 * `permission` to run and apply it, `viewPermission` to see its plans): imports.* alone never reaches a record. Money
 * columns need their grain as well, to import and to see. Not step-up (A1 §3.10, as files).
 */
export const IMPORTS_DEFINITIONS = definePermissions('imports', {
  view: { risk: 'read', description: 'See import jobs and their plans (values of money columns only with their grain).' },
  run: { risk: 'write', description: 'Upload a sheet for an import and see its dry run; cancel an import.' },
  apply: { risk: 'write', description: "Apply an import's plan: its valid rows are written to the records." },
})
export const IMPORTS_VIEW = 'imports.view' satisfies Permission
export const IMPORTS_RUN = 'imports.run' satisfies Permission
export const IMPORTS_APPLY = 'imports.apply' satisfies Permission

/**
 * Company documents as PDF (apps/factory-api platform/documents; plan A1 §3.9, GAP-008). An issued document's PDF is
 * made by the command that issues it, under that module's own permission (quotes.send, ddt.issue, invoices.issue…);
 * documents.view shows the fixed layouts with a company's legal data (the letterhead preview), stored nowhere.
 */
export const DOCUMENTS_DEFINITIONS = definePermissions('documents', {
  view: { risk: 'read', description: "Preview a company's document layouts (quote, purchase order, DDT, invoice copy) with its legal data." },
})
export const DOCUMENTS_VIEW = 'documents.view' satisfies Permission

/**
 * Printing (apps/factory-api platform/print; plan A1 §3.9, GAP-007): printers per site and print jobs through the
 * site's print relay, or a PDF for the browser. Each is checked with can() against the printer's company and site; a
 * floor session prints only at its own device's site. Sending a failed job again needs the permission that queued it.
 */
export const PRINT_DEFINITIONS = definePermissions('print', {
  view: { risk: 'read', description: "See a site's printers and its print jobs." },
  labels: { risk: 'write', description: "Print labels (hides, lots, bundles, cartons) on a site's label printer, or as a PDF for any printer." },
  documents: { risk: 'write', description: "Print a record's PDF document on a site's printer." },
  manage: { risk: 'write', description: 'Add printers to a site and change them: name, relay target, label stock, pause, archive.' },
})
export const PRINT_VIEW = 'print.view' satisfies Permission
export const PRINT_LABELS = 'print.labels' satisfies Permission
export const PRINT_DOCUMENTS = 'print.documents' satisfies Permission
export const PRINT_MANAGE = 'print.manage' satisfies Permission

/**
 * Email out (apps/factory-api platform/email-out; plan A1 §3.7; PLT-139, PLT-230, COL-024). email.send is checked with
 * can() against the record's company, site and party, like threads.post; email.manage against the identity's company,
 * and it is a step-up permission (A1 §3.10: what changes who the company's mail appears to come from).
 * Email in (platform/email-in; COL-022, COL-023, A2 SCR-019 "Mail to sort"): email.triage against the received mail's
 * company (the SES account's; none: every company), and for an assignment also threads.post over the record.
 */
export const EMAIL_DEFINITIONS = definePermissions('email', {
  send: { risk: 'write', description: "Send mail from a record's thread to its customer or supplier, as yourself, from the company's verified address." },
  manage: { risk: 'stepUp', description: "Add and change the companies' sending identities: SES domains, DKIM, how the From line names the sender, the default." },
  triage: { risk: 'write', description: 'Sort received mail no record took or that waits for a person: read it, assign it to a record, release it, or throw it away.' },
})
export const EMAIL_SEND = 'email.send' satisfies Permission
export const EMAIL_MANAGE = 'email.manage' satisfies Permission
export const EMAIL_TRIAGE = 'email.triage' satisfies Permission

/**
 * The outside services the factory rents (apps/factory-api platform/admin/connections; design 02 admin.connections,
 * SCR-087; PLT-139, PLT-195, PLT-197): each IntegrationAccount (SES, R2, SDI, Sendcloud, VIES) with its mode, state,
 * calls and received webhooks. integrations.view reads them (never a secret: secrets are sealed and write-only);
 * integrations.manage pauses an account (the kill switch: the gateway refuses its calls) and resumes it, each after a
 * confirm. Checked with can() against the account's company; a tenant-wide account (SES, R2, VIES: every company's
 * mail, files, VAT checks) needs a grant over every active company. Not step-up: nothing it does widens what anyone
 * can see or do, and the account's secrets stay sealed (connecting and replacing secrets come later).
 */
export const INTEGRATIONS_DEFINITIONS = definePermissions('integrations', {
  view: { risk: 'read', description: "See the outside services the factory uses (mail, files, SDI, carriers, VAT checks): what each is for, its mode, whether it works, its calls and received messages; never a secret." },
  manage: { risk: 'write', description: 'Pause a service so no call reaches it, and resume it.' },
})
export const INTEGRATIONS_VIEW = 'integrations.view' satisfies Permission
export const INTEGRATIONS_MANAGE = 'integrations.manage' satisfies Permission

/**
 * Compliance: the EU type-examination certificate register (apps/factory-api modules/compliance/certificates; QHS-103,
 * QHS-051, PRD-288; Reg. (EU) 2016/425). Checked with can() against the certificate's company and holder party. The
 * constants live in factory-domain/src/compliance/certificates/permissions.ts. Not step-up: a certificate is typed from
 * the notified body's PDF, and registering one needs that PDF on the record. The style compliance tab (B-W1-20,
 * factory-domain/src/product/compliance/permissions.ts) reads with certificates.view and uploads the signed DoC and
 * leaflet with declarations.manage (not step-up either: the PDF was signed by hand before it is uploaded). The PPE
 * register (B-W1-43, factory-domain/src/compliance/register/permissions.ts) is read with register.view and kept with
 * register.manage, over the entry's company and reporting party; not step-up (every move is audited and an entry is
 * never deleted).
 */
export const COMPLIANCE_DEFINITIONS = definePermissions('compliance', {
  'certificates.view': {
    risk: 'read',
    description:
      "See the EU type-examination certificates, what they cover and when they expire; ask the certificate gate whether a garment is covered; see a style's compliance: its PPE class, coverage per colourway and size, Declarations of Conformity and user information leaflets; see the garment label templates and preview a garment label.",
  },
  'certificates.manage': { risk: 'write', description: 'Type in certificates, register them with their PDF, suspend, reinstate and withdraw them, and record or end what they cover.' },
  'declarations.manage': { risk: 'write', description: "Upload a style revision's signed EU Declaration of Conformity and user information leaflet per language, and replace them with a new version (the old one is kept)." },
  'labels.manage': {
    risk: 'write',
    description: 'Build garment label templates (maker, composition, animal-origin phrase, care symbols, layout), activate them when their rule checks pass, retire and revise them, print a test label, and name one on a draft style revision.',
  },
  'register.view': {
    risk: 'read',
    description: 'See the PPE register of complaints, non-conformities and recalls, and for each entry where the garments it concerns went: work orders, shipments, DDTs and the customers that got them.',
  },
  'register.manage': {
    risk: 'write',
    description: 'Record complaints, non-conformities and recalls in the PPE register, edit an open entry and its risk assessment, record the corrective action, the information to distributors and the notice to the authority, and close the entry.',
  },
})

/**
 * Inventory: locations, the stock ledger and the stock overview (apps/factory-api modules/inventory; SCM-176, SCM-189,
 * SCM-192, SCM-280). Checked with can() against the site's company and the site; a floor device works only at its own
 * site. Values (costs) also need the cost grain. The constants live in factory-domain/src/inventory/permissions.ts.
 */
export const INVENTORY_DEFINITIONS = definePermissions('inventory', {
  'locations.view': { risk: 'read', description: "See a site's locations: the tree of warehouses, zones and bins, with their codes." },
  'locations.manage': { risk: 'write', description: 'Create, rename, move and archive (when empty) the locations of a site, and import them from a sheet.' },
  'stock.view': { risk: 'read', description: 'See the stock: on hand, held and available per location, item, lot and hide; the moves behind each figure; the ledger check (values only with the cost grain).' },
  adjust: { risk: 'write', description: "Correct stock up or down with a reason, and post a count's differences." },
  transfer: { risk: 'write', description: 'Move stock between two locations of a site (a floor device: at its own site).' },
  scrap: { risk: 'write', description: 'Take stock out as scrap, with the reason.' },
  reverse: { risk: 'write', description: 'Reverse a stock move that was wrong: the same move with its locations swapped, with the reason.' },
  issue: { risk: 'write', description: "Pick and issue stock to a work order (only usable stock of the work order's materials, up to what it still needs), return what it did not use, and undo one's own last issue (a floor device: at its own site)." },
  'issue.over': { risk: 'write', description: 'Issue more than a work order still needs, with the reason.' },
  receive: { risk: 'write', description: 'Receive goods against a purchase order: the receipt, its lots and its hides one by one with their measured areas, posted to the stock ledger (a floor device: at its own site).' },
  'opening.import': { risk: 'write', description: "Load a company's opening stock from a sheet: lots, hides with their areas and the existing chromium VI reports, posted as opening moves. Lots that need the quality step wait in quarantine for a quality person who did not import them." },
  // B-W2a-11 (inventory/reservations/permissions.ts): reservations; their reads are stock.view.
  reserve: { risk: 'write', description: 'Reserve stock of a site for a work order or a sales order line (a quantity, an area of leather, named hides), only from what is available, and release a reservation with the reason.' },
})

/** The money grains as they travel in grants (`../grains/grains`): from Role.grains, never Role.permissions. */
export const MONEY_PERMISSIONS: PermissionDefinition[] = GRAINS.map((grain) =>
  Object.freeze({ name: grainPermission(grain), area: 'money', description: GRAIN_DESCRIPTIONS[grain], risk: 'read' as const, grain }),
)

export const FACTORY_PERMISSIONS = permissionRegistry([
  USERS_PERMISSIONS,
  ROLES_PERMISSIONS,
  AUDIT_PERMISSIONS,
  NUMBERING_DEFINITIONS,
  // B-W2b-24: numbering.override (PLT-125).
  NUMBERING_OVERRIDE_DEFINITIONS,
  FILES_DEFINITIONS,
  LINKS_PERMISSIONS,
  LINK_SESSION_PERMISSIONS,
  DEVICES_PERMISSIONS,
  WORKERS_PERMISSIONS,
  FLOOR_PERMISSIONS,
  THREADS_DEFINITIONS,
  IMPORTS_DEFINITIONS,
  DOCUMENTS_DEFINITIONS,
  PRINT_DEFINITIONS,
  EMAIL_DEFINITIONS,
  INTEGRATIONS_DEFINITIONS,
  COMPLIANCE_DEFINITIONS,
  PRODUCT_MATERIALS_DEFINITIONS,
  PRODUCT_STYLES_DEFINITIONS,
  PRODUCT_BOM_DEFINITIONS,
  PRODUCT_ROUTING_DEFINITIONS,
  INVENTORY_DEFINITIONS,
  INVENTORY_COUNTS_DEFINITIONS,
  // B-W2a-31: receiving every day.
  INVENTORY_DISCREPANCIES_DEFINITIONS,
  // B-W2b-94: hides as stock.
  INVENTORY_HIDES_DEFINITIONS,
  // B-W2b-100: one shade lot per order.
  INVENTORY_SHADE_DEFINITIONS,
  // B-W2b-326: transfers between sites.
  INVENTORY_TRANSFERS_DEFINITIONS,
  SHIPPING_DEFINITIONS,
  SHIPPING_LABELS_DEFINITIONS,
  PARTIES_DEFINITIONS,
  PLANNING_DEFINITIONS,
  PLANNING_SETTINGS_DEFINITIONS,
  // B-W2a-22: firm planned orders and the exception list.
  PLANNING_FIRM_DEFINITIONS,
  PLANNING_EXCEPTIONS_DEFINITIONS,
  // B-W2a-34: the planning board's working plan and its publication.
  PLANNING_SCHEDULE_DEFINITIONS,
  // B-W2b-132: the leather and cut plan's cutting loss.
  PLANNING_LEATHER_DEFINITIONS,
  PURCHASING_DEFINITIONS,
  INVOICES_DEFINITIONS,
  PAYMENTS_DEFINITIONS,
  COSTING_DEFINITIONS,
  PRODUCTION_SETTINGS_DEFINITIONS,
  PRODUCTION_CUTTING_DEFINITIONS,
  PRODUCTION_BUNDLES_DEFINITIONS,
  PRODUCTION_SCANS_DEFINITIONS,
  PRODUCTION_SERIALS_DEFINITIONS,
  // B-W2a-12 (production/completion/permissions.ts)
  PRODUCTION_COMPLETION_DEFINITIONS,
  PRODUCTION_REWORK_DEFINITIONS,
  PRODUCTION_SCRAP_DEFINITIONS,
  WORKORDERS_DEFINITIONS,
  QUOTES_DEFINITIONS,
  SALES_SETTINGS_DEFINITIONS,
  COMPANIES_DEFINITIONS,
  COMPANY_BANK_DEFINITIONS,
  SITES_DEFINITIONS,
  ORDERS_DEFINITIONS,
  PRIVACY_DEFINITIONS,
  QUALITY_LAB_DEFINITIONS,
  QUALITY_FINAL_DEFINITIONS,
  HOME_DEFINITIONS,
  // B-W2a-79: the report library.
  HOME_REPORTS_DEFINITIONS,
  FLOOR_SYNC_DEFINITIONS,
  CALENDARS_DEFINITIONS,
  // B-W2a-10: approved sources (purchasing.sources.manage).
  PURCHASING_SOURCES_DEFINITIONS,
  // B-W2a-25: subcontracting (purchasing.subcontract.manage | kit | receive).
  PURCHASING_SUBCONTRACT_DEFINITIONS,
  // B-W2a-44: supplier claims and returns to the supplier (purchasing.claims.manage | return).
  PURCHASING_CLAIMS_DEFINITIONS,
  // B-W2a-18: the reason lists.
  REASONS_DEFINITIONS,
  // B-W2a-19: paymentterms.view | manage, pricelists.view | manage.
  PAYMENT_TERMS_DEFINITIONS,
  PRICE_LISTS_DEFINITIONS,
  // B-W2a-20: tasks on any record (tasks.manage).
  TASKS_DEFINITIONS,
  // B-W2a-26: defects, dispositions, holds.
  QUALITY_DEFECTS_DEFINITIONS,
  QUALITY_HOLDS_DEFINITIONS,
  // B-W2a-47: nonconformances (quality.ncr.view | raise | manage | approve | close).
  QUALITY_NCR_DEFINITIONS,
  // B-W2a-23: saved views and exports.
  VIEWS_DEFINITIONS,
  // B-W2a-32: rebuilding the search index.
  SEARCH_DEFINITIONS,
  // B-W2a-35: the plant.
  PLANT_DEFINITIONS,
  // B-W2a-33: exception rules and stored alerts (alerts.view | handle | rules.manage).
  ALERTS_DEFINITIONS,
  // B-W2a-39: the accounting exports and the period locks.
  ACCOUNTING_DEFINITIONS,
  // B-W2b-201: who gives the accountant the guest portal (area `accounting`).
  ACCOUNTANTS_DEFINITIONS,
  // B-W2a-36: Security & health.
  SECURITY_DEFINITIONS,
  // B-W2a-43: customer returns.
  SALES_RETURNS_DEFINITIONS,
  // B-W2a-38: production reports (production.reports.view | subscribe).
  PRODUCTION_REPORTS_DEFINITIONS,
  // B-W2a-41: the mail delivery log and the blocked addresses.
  EMAIL_DELIVERY_DEFINITIONS,
  // B-W2a-48: shipping every day (freight charged, intra-EU transport evidence).
  SHIPPING_DAILY_DEFINITIONS,
  // B-W2a-57: repairs and alterations.
  SALES_REPAIRS_DEFINITIONS,
  // B-W2a-55: receivables (the ageing, statements, the reminder ladder a person approves).
  RECEIVABLES_DEFINITIONS,
  // B-W2a-62: payables (supplier and subcontractor invoices, the three-way match, approval, payment).
  PAYABLES_DEFINITIONS,
  // B-W2a-65: customer complaints (log, triage, the owner's acknowledgement of a safety alert).
  QUALITY_COMPLAINTS_DEFINITIONS,
  // B-W2b-14: the Owner's switch for automatic PO confirmation reminders.
  PURCHASING_REMINDERS_DEFINITIONS,
  // B-W2b-26: people (people.view | team.view | employees.manage | teams.manage | loans.manage | leavers.manage).
  PEOPLE_EMPLOYEES_DEFINITIONS,
  PEOPLE_TEAMS_DEFINITIONS,
  PEOPLE_LEAVERS_DEFINITIONS,
  // B-W2b-27: privacy of people data.
  PEOPLE_PRIVACY_DEFINITIONS,
  // B-W2b-29: off-standard and indirect time.
  PRODUCTION_OFFSTANDARD_DEFINITIONS,
  // B-W2b-35: help calls (production.calls.view | answer | manage).
  PRODUCTION_CALLS_DEFINITIONS,
  // B-W2b-32: shifts and overtime requests.
  PEOPLE_SHIFTS_DEFINITIONS,
  // B-W2b-46: checks before a scan counts (production.scan.override).
  PRODUCTION_GUARDS_DEFINITIONS,
  // B-W2b-47: more on the tablet (production.scan.behalf, production.extraops.add).
  PRODUCTION_ONBEHALF_DEFINITIONS,
  PRODUCTION_EXTRAOPS_DEFINITIONS,
  // B-W2b-39: skills and machine authorisations.
  PEOPLE_SKILLS_DEFINITIONS,
  // B-W2b-34: piece rates and the legal switch of piece pay.
  PEOPLE_PIECERATES_DEFINITIONS,
  // B-W2b-33: clock in and out.
  PEOPLE_CLOCK_DEFINITIONS,
  // B-W2b-37: attendance days.
  PEOPLE_ATTENDANCE_DEFINITIONS,
  // B-W2b-44: efficiency.
  PEOPLE_EFFICIENCY_DEFINITIONS,
  // B-W2b-42: overtime worked, timesheets, working-time limits.
  PEOPLE_OVERTIME_DEFINITIONS,
  // B-W2b-48: the month close.
  PEOPLE_CLOSE_DEFINITIONS,
  PEOPLE_LIMITS_DEFINITIONS,
  // B-W2b-43: earnings and pay periods.
  PEOPLE_EARNINGS_DEFINITIONS,
  // B-W2b-54: the payroll export.
  PEOPLE_PAYROLL_DEFINITIONS,
  // B-W2b-45: labour records and corrections.
  PRODUCTION_LABOUR_DEFINITIONS,
  // B-W2b-50: line targets and boards (production.boards.view | targets | reason).
  PRODUCTION_BOARDS_DEFINITIONS,
  PRODUCTION_DISPATCH_DEFINITIONS,
  // B-W2b-93: AQL profiles and the AQL calculator.
  QUALITY_AQL_DEFINITIONS,
  // B-W2b-92: inspection plans.
  QUALITY_PLANS_DEFINITIONS,
  // B-W2b-101: inspection triggers.
  QUALITY_TRIGGERS_DEFINITIONS,
  // B-W2b-98: the incoming inspection, hide by hide.
  QUALITY_INCOMING_DEFINITIONS,
  // B-W2b-99: in-process checks.
  QUALITY_INPROCESS_DEFINITIONS,
  // B-W2b-107: rolls, protector lots and consumables.
  INVENTORY_ROLLS_DEFINITIONS,
  // B-W2b-108: corrective actions, CAPA and 8D.
  QUALITY_CAPA_DEFINITIONS,
  // B-W2b-124: statutory periodic checks of machines.
  PLANT_CHECKS_DEFINITIONS,
  // B-W2b-123: amendments of signed results; the inspection report and the certificate of conformity.
  QUALITY_AMENDMENTS_DEFINITIONS,
  QUALITY_DOCUMENTS_DEFINITIONS,
  // B-W2b-120: the safety organisation and the safety calendar.
  SAFETY_DEFINITIONS,
  SAFETY_CALENDAR_DEFINITIONS,
  // B-W2b-118: quality rules.
  QUALITY_RULES_DEFINITIONS,
  // B-W2b-126: the repair station and second quality.
  PRODUCTION_REPAIR_DEFINITIONS,
  // B-W2b-122: the risk assessment, the DVR.
  SAFETY_RISK_DEFINITIONS,
  // B-W2b-125: incidents, near misses and hazards.
  SAFETY_INCIDENTS_DEFINITIONS,
  // B-W2b-138: quality reports.
  QUALITY_REPORTS_DEFINITIONS,
  // B-W2b-128: role sheets.
  SAFETY_ROLESHEETS_DEFINITIONS,
  // B-W2b-133: the course catalogue and training requirements.
  SAFETY_TRAINING_DEFINITIONS,
  // B-W2b-134: PPE for workers.
  SAFETY_PPE_DEFINITIONS,
  // B-W2b-143: the chemical register and the safety data sheets.
  SAFETY_CHEMICALS_DEFINITIONS,
  // B-W2b-135: health surveillance.
  SAFETY_HEALTH_DEFINITIONS,
  // B-W2b-139: training records, attendance and the instruction register.
  SAFETY_RECORDS_DEFINITIONS,
  // B-W2b-161: company branding.
  BRANDING_DEFINITIONS,
  // B-W2b-162: partner organisations (the office's) and the portal's own (partner roles only).
  PARTNERS_DEFINITIONS,
  PORTAL_DEFINITIONS,
  // B-W2b-167: the partner's Home and the office's requests to partners.
  PORTAL_HOME_DEFINITIONS,
  PARTNER_TASKS_DEFINITIONS,
  // B-W2b-175: customer orders in the portal (partner roles only).
  PORTAL_SALES_ORDERS_DEFINITIONS,
  // B-W2b-174: supplier orders in the portal.
  PORTAL_PURCHASE_ORDERS_DEFINITIONS,
  // B-W2b-177: required documents.
  REQUIRED_DOCUMENTS_DEFINITIONS,
  // B-W2b-178: customer documents in the portal (partner roles only).
  PORTAL_CUSTOMER_DOCUMENTS_DEFINITIONS,
  // B-W2b-190: portal ordering (partner roles only).
  PORTAL_ORDERING_DEFINITIONS,
  // B-W2b-183: change and cancel requests from the portal (partner roles only).
  PORTAL_ORDER_CHANGES_DEFINITIONS,
  MONEY_PERMISSIONS,
  // B-W2b-168: portal search (partner roles only; its area `portal` is declared above, so the area order stays).
  PORTAL_SEARCH_DEFINITIONS,
  // B-W2b-185: paying in the customer portal (partner roles only).
  PORTAL_PAYMENTS_DEFINITIONS,
  // B-W2b-176: subcontractor jobs in the portal (partner roles only; area `portal`, declared above).
  PORTAL_JOBS_DEFINITIONS,
  // B-W2b-182: ship notices in the portal (partner roles only; area `portal`, declared above).
  PORTAL_SHIP_NOTICES_DEFINITIONS,
  // B-W2b-189: supplier documents and profile in the portal (partner roles only), and the office's check.
  PORTAL_SUPPLIER_PROFILE_DEFINITIONS,
  SUPPLIER_REVIEW_DEFINITIONS,
  // B-W2b-192: returns and complaints from outside (partner roles only; area `portal`, declared above).
  PORTAL_RETURNS_DEFINITIONS,
  // B-W2b-184: approval requests to partners (the office's in area `partners`, the partner's in `portal`, both declared above).
  PARTNERS_APPROVALS_DEFINITIONS,
  PORTAL_APPROVALS_DEFINITIONS,
  // B-W2b-200: inviting a partner to one record (area `partners`, declared above).
  PARTNERS_SHARES_DEFINITIONS,
  // B-W2b-201: the accountant's room (partner roles only; area `portal`, declared above).
  PORTAL_ACCOUNTING_DEFINITIONS,
  // B-W2b-112: cut orders and cut tickets (area `production`, declared above).
  PRODUCTION_CUTORDERS_DEFINITIONS,
  // B-W2b-117: recut tickets, secondary processes and trolleys to sewing (area `production`, declared above).
  PRODUCTION_CUTISSUE_DEFINITIONS,
  // B-W2b-171: measurements by link (area `sales`, declared above).
  SALES_MEASUREMENTS_DEFINITIONS,
  // B-W2b-172: the supplier questionnaire (area `purchasing`, declared above).
  QUESTIONNAIRE_DEFINITIONS,
  // B-W2b-208: the textile, leather and origin checks' switches (area `compliance`, declared above).
  TEXTILE_RULES_DEFINITIONS,
  // B-W2b-214: work instructions (production.instructions.view | manage | approve | people).
  PRODUCTION_INSTRUCTIONS_DEFINITIONS,
  // B-W2b-215: SMV governance (area `product`, declared above).
  PRODUCT_SMV_DEFINITIONS,
  // B-W2b-221: the style lifecycle and the product settings (area `product`, declared above).
  PRODUCT_LIFECYCLE_DEFINITIONS,
  // B-W2b-227: GTINs from the company's own GS1 range (area `product`, declared above).
  PRODUCT_GTINS_DEFINITIONS,
  // B-W2b-226: change requests and change orders (area `product`, declared above).
  PRODUCT_CHANGES_DEFINITIONS,
  // B-W2b-229: the option library and option prices (area `product`, declared above).
  PRODUCT_OPTIONS_DEFINITIONS,
  // B-W2b-238: materials in depth (area `product`, declared above).
  PRODUCT_MATERIALS_DEPTH_DEFINITIONS,
  // B-W2b-249: Rules & markets and the phrase library (area `compliance`, declared above).
  RULES_LIBRARY_DEFINITIONS,
  PHRASES_DEFINITIONS,
  // B-W2b-254: requirements and gates (area `compliance`, declared above).
  REQUIREMENTS_DEFINITIONS,
  // B-W2b-230: the tech pack PDF (area `product`, declared above).
  PRODUCT_TECHPACKS_DEFINITIONS,
  // B-W2b-233: prepacks (area `product`, declared above).
  PRODUCT_PREPACKS_DEFINITIONS,
  // B-W2b-250: restricted substances and their rules (area `compliance`, declared above).
  SUBSTANCES_DEFINITIONS,
  // B-W2b-246: sample rounds (area `sales`, declared above).
  SALES_SAMPLES_DEFINITIONS,
  // B-W2b-251: technical files (area `compliance`, declared above).
  TECHFILES_DEFINITIONS,
  // B-W2b-257: the DoC generator (area `compliance`, declared above).
  DECLARATIONS_DEFINITIONS,
  // B-W2b-252: sample decisions (area `sales`, declared above).
  SALES_SAMPLE_DECISIONS_DEFINITIONS,
  // B-W2b-260: recall, withdrawal and authority (area `compliance`, declared above).
  RECALL_DEFINITIONS,
  // B-W2b-258: the user information builder (area `compliance`, declared above).
  USER_INFORMATION_DEFINITIONS,
  // B-W2b-256: supplier declarations (area `compliance`, declared above).
  SUPPLIER_DECLARATIONS_DEFINITIONS,
  // B-W2b-259: label artwork (area `compliance`, declared above).
  LABEL_ARTWORK_DEFINITIONS,
  // B-W2b-272: compliance reports (area `compliance`, declared above).
  COMPLIANCE_REPORTS_DEFINITIONS,
  // B-W2b-263
  PLANNING_MILESTONES_DEFINITIONS,
  // B-W2b-248: made-to-measure rules (area `product`, declared above).
  PRODUCT_MTM_DEFINITIONS,
  // B-W2b-264: sourcing & claims (area `compliance`, declared above).
  CLAIMS_DEFINITIONS,
  // B-W2b-262: the brand's samples and tech packs (area `portal`, partner, declared above).
  PORTAL_SAMPLES_DEFINITIONS,
  // B-W2b-247: the colour library and the branding sets (area `product`, declared above).
  PRODUCT_COLOURS_DEFINITIONS,
  PRODUCT_BRANDING_DEFINITIONS,
  // B-W2b-282: one approval engine.
  APPROVALS_DEFINITIONS,
  // B-W2b-296: purchase orders in depth (area `purchasing`, declared above).
  PO_DEPTH_DEFINITIONS,
  // B-W2b-332: ask to buy (area `purchasing`).
  ASK_TO_BUY_DEFINITIONS,
  // B-W2b-288: the PPE text approvals (area `compliance`, declared above).
  PPE_TEXTS_DEFINITIONS,
  // B-W2b-313: lots in depth (area `inventory`, declared above).
  INVENTORY_LOTS_DEPTH_DEFINITIONS,
  // B-W2b-290: customers in depth (area `parties`, declared above).
  PARTIES_HOLD_DEFINITIONS,
  PARTIES_PRIVACY_DEFINITIONS,
  // B-W2b-295: inquiries (area `sales`).
  SALES_INQUIRIES_DEFINITIONS,
  // B-W2b-314: the warehouse rules (area `inventory`, declared above).
  INVENTORY_RULES_DEFINITIONS,
  // B-W2b-293: planned work and subcontract orders (area `planning`, declared above).
  PLANNING_PLANNED_DEFINITIONS,
  PLANNING_PROMISE_DEFINITIONS,
  // B-W2b-312: scheduling in depth (area `planning`, declared above).
  PLANNING_SCHEDULE_DEPTH_DEFINITIONS,
  // B-W2b-317: the backlog ranked (area `planning`, declared above).
  PLANNING_BACKLOG_DEFINITIONS,
  // B-W2b-321
  PLANNING_SUBCONTRACT_DEFINITIONS,
  // B-W2b-311: suppliers in depth (area `purchasing`, declared above).
  SUPPLIERS_DEPTH_DEFINITIONS,
  // B-W2b-292: the warehouse task inbox (area `inventory`).
  INVENTORY_TASKS_DEFINITIONS,
  // B-W2b-331: subcontracting in depth (area `purchasing`, declared above).
  SUBCONTRACT_DEPTH_DEFINITIONS,
  // B-W2b-356: warehouse reports (area `inventory`, declared above).
  INVENTORY_REPORTS_DEFINITIONS,
  // B-W2b-315: bank details (area `purchasing`, declared above; the portal's flagged partner), qualification and the compliance gate.
  BANK_DEFINITIONS,
  PORTAL_BANK_DEFINITIONS,
  QUALIFICATION_DEFINITIONS,
  // B-W2b-319: the production strategy per item (area `planning`, declared above).
  PLANNING_STRATEGY_DEFINITIONS,
  // B-W2b-350: purchasing reports (area `purchasing`, declared above).
  PURCHASING_REPORTS_DEFINITIONS,
  // B-W2b-349: planning reports (area `planning`, declared above).
  PLANNING_REPORTS_DEFINITIONS,
  // B-W2b-348: sales reports (area `sales`, declared above).
  SALES_REPORTS_DEFINITIONS,
  // B-W2b-299: counts in depth (area `inventory`).
  INVENTORY_COUNTS_DEPTH_DEFINITIONS,
  // B-W2b-304: credit limits (area `sales`).
  SALES_CREDIT_DEFINITIONS,
  // B-W2b-294: quote templates (area `quotes`, declared above).
  QUOTE_TEMPLATES_DEFINITIONS,
  // B-W2b-306: MRP you can trust (area `planning`, declared above).
  PLANNING_ACTIONS_DEFINITIONS,
  // B-W2b-300: goods without a PO (area `inventory`).
  INVENTORY_UNPLANNED_DEFINITIONS,
  // B-W2b-345: warranty and service cases (area `sales`).
  SALES_SERVICE_DEFINITIONS,
  // B-W2b-351: product-safety reports and the accident log (area `sales`).
  SALES_SAFETY_DEFINITIONS,
  // B-W2b-358: the made-to-measure office (area `sales`).
  SALES_MTM_DEFINITIONS,
  // B-W2b-360: fittings, alterations and remakes (area `sales`).
  SALES_FITTINGS_DEFINITIONS,
  // B-W2b-384: packing in depth (area `shipping`).
  SHIPPING_PACKAGING_DEFINITIONS,
  // B-W2b-386: the shipment queue in depth (area `shipping`).
  SHIPPING_HOLDS_DEFINITIONS,
  // B-W2b-391: labels and documents (area `shipping`).
  SHIPPING_PROFORMA_DEFINITIONS,
  // B-W2b-385: the notification defaults of each office role (area `home`).
  NOTIFICATION_DEFAULTS_DEFINITIONS,
  // B-W2b-389: currencies and exchange rates (area `currencies`).
  CURRENCY_DEFINITIONS,
  // B-W2b-392: tax rules as data (area `invoices`).
  TAX_RULES_DEFINITIONS,
  // B-W2b-393: bank statements, matching and write-offs (area `payments`).
  PAYMENTS_BANK_DEFINITIONS,
  WRITE_OFF_DEFINITIONS,
  // B-W2b-394: team inboxes and the capture address (area `email`, declared above).
  MAIL_DEPTH_DEFINITIONS,
])

/** The area of the permissions only floor roles hold (and floor roles hold no other, but FLOOR_SHARED_PERMISSIONS). */
export const FLOOR_AREA = 'floor'

/**
 * The office permissions a floor role may hold too: what a floor device does on the same routes as the office, at its
 * own device's site only (can() pins a floor session to it, row-level security too). Printing labels at the site's
 * printer (GAP-007) and seeing its print queue; seeing the site's locations and moving stock between them (SCM-176,
 * SCM-189); picking and issuing to the site's work orders (SCM-215, SCR-093); cutting hides for them (MES-056, SCR-094);
 * making their bundles and printing the tickets (MES-065, MES-066, SCR-095); reporting bundles at operations, undoing
 * the last report and asking corrections (MES-069, MES-090, MES-095, MES-096, SCR-090); printing the garment labels of
 * the final operation (MES-076, PRD-348, SCR-096); the final inspection and release at the bench (QHS-050, QHS-058,
 * SCR-097); packing the site's shipments (LOG-039, SCR-098); rework sent back and finished (MES-126). Never a money grain;
 * floor roles still hold no other office permission.
 */
export const FLOOR_SHARED_PERMISSIONS: readonly Permission[] = Object.freeze([PRINT_VIEW, PRINT_LABELS, ...INVENTORY_FLOOR_PERMISSIONS, ...PRODUCTION_CUTTING_FLOOR_PERMISSIONS, ...PRODUCTION_BUNDLES_FLOOR_PERMISSIONS, ...PRODUCTION_SCANS_FLOOR_PERMISSIONS, ...PRODUCTION_SERIALS_FLOOR_PERMISSIONS, ...PRODUCTION_REWORK_FLOOR_PERMISSIONS, ...QUALITY_FINAL_FLOOR_PERMISSIONS, ...SHIPPING_FLOOR_PERMISSIONS,
  // B-W2a-35: report a machine problem at the station (H1: anyone); the technician's jobs and the sign-safe with the PIN.
  ...PLANT_FLOOR_PERMISSIONS,
  // B-W2a-43: the dock receives a customer return and grades it (never a price, a credit or a decision).
  ...SALES_RETURNS_FLOOR_PERMISSIONS,
  // B-W2a-76: the warehouse tablet sends a subcontract kit (with its DDT) and receives the goods back (never a fee).
  ...PURCHASING_SUBCONTRACT_FLOOR_PERMISSIONS,
  // B-W2b-35: the line's call states and answering help calls (the team leader's line view, a technician's tablet).
  ...PRODUCTION_CALLS_FLOOR_PERMISSIONS,
  // B-W2b-46: the team leader's override of a held scan, signed on the tablet with their PIN.
  ...PRODUCTION_GUARDS_FLOOR_PERMISSIONS,
  // B-W2b-47: the team leader records work for someone who could not scan, and adds an unplanned operation.
  ...PRODUCTION_ONBEHALF_FLOOR_PERMISSIONS,
  ...PRODUCTION_EXTRAOPS_FLOOR_PERMISSIONS,
  // B-W2b-50: the team leader's line view reads its line's hour by hour and board, and gives a short hour's reason.
  ...PRODUCTION_BOARDS_FLOOR_PERMISSIONS,
  ...PRODUCTION_DISPATCH_FLOOR_PERMISSIONS,
  // B-W2b-98: the inspection tablet at the dock inspects a lot hide by hide and signs the decision with the PIN.
  ...QUALITY_INCOMING_FLOOR_PERMISSIONS,
  // B-W2b-99: the floor inspector and the team leader record in-process checks at their own site.
  ...QUALITY_INPROCESS_FLOOR_PERMISSIONS,
  // B-W2b-107: the line's tablet records which protector lot a batch or garment holds (EN 1621).
  ...INVENTORY_ROLLS_FLOOR_PERMISSIONS,
  // B-W2b-126: the repair station's queue and its scans in and out at its own site.
  ...PRODUCTION_REPAIR_FLOOR_PERMISSIONS,
  // B-W2b-117: recuts asked at sewing or quality, secondary processes moved and trolleys loaded, sent and received.
  ...PRODUCTION_CUTISSUE_FLOOR_PERMISSIONS,
  // B-W2b-299: a running count counted by scanning every unit at the device's site (never a cost).
  ...INVENTORY_COUNTS_DEPTH_FLOOR_PERMISSIONS])

// The modules' constants and their declarations name the same permissions.
for (const name of [NUMBERING_VIEW, NUMBERING_MANAGE, FILES_READ, FILES_UPLOAD, FILES_DELETE, FILES_MANAGE, ...LINKS_OFFICE_PERMISSIONS, THREADS_READ, THREADS_POST, THREADS_MANAGE, IMPORTS_VIEW, IMPORTS_RUN, IMPORTS_APPLY, DOCUMENTS_VIEW, PRINT_VIEW, PRINT_LABELS, PRINT_DOCUMENTS, PRINT_MANAGE, EMAIL_SEND, EMAIL_MANAGE, EMAIL_TRIAGE, ...CERTIFICATES_PERMISSIONS, ...REGISTER_PERMISSIONS, ...PRODUCT_MATERIALS_PERMISSIONS, ...INVENTORY_PERMISSIONS, ...INVENTORY_RESERVATION_PERMISSIONS, ...PRODUCT_STYLES_PERMISSIONS, ...PRODUCT_BOM_PERMISSIONS, ...PRODUCT_ROUTING_PERMISSIONS, ...SHIPPING_PERMISSIONS, ...SHIPPING_LABELS_PERMISSIONS, ...PARTIES_PERMISSIONS, ...PLANNING_PERMISSIONS, ...PURCHASING_PERMISSIONS, ...INVOICES_PERMISSIONS, ...PAYMENTS_PERMISSIONS, ...COSTING_PERMISSIONS, ...PRODUCTION_SETTINGS_PERMISSIONS, ...PRODUCTION_CUTTING_PERMISSIONS, ...PRODUCTION_BUNDLES_PERMISSIONS, ...PRODUCTION_SCANS_PERMISSIONS, ...PRODUCTION_SERIALS_PERMISSIONS, ...WORKORDERS_PERMISSIONS, ...QUOTES_PERMISSIONS, ...SALES_SETTINGS_PERMISSIONS, ...COMPANY_BANK_PERMISSIONS, ...ORDERS_PERMISSIONS, ...PRIVACY_PERMISSIONS, ...QUALITY_LAB_PERMISSIONS, ...QUALITY_FINAL_PERMISSIONS, ...HOME_PERMISSIONS, ...FLOOR_SYNC_PERMISSIONS, ...CALENDARS_PERMISSIONS, ...INVENTORY_COUNTS_PERMISSIONS, ...PURCHASING_SOURCES_PERMISSIONS, ...PRODUCTION_REWORK_PERMISSIONS, ...PRODUCTION_SCRAP_PERMISSIONS]) {
  if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
}
// B-W2a-12: report finished to stock (its own line, a merge point).
for (const name of PRODUCTION_COMPLETION_PERMISSIONS) {
  if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
}
// B-W2a-16: planning settings and capacity.
for (const name of PLANNING_SETTINGS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-25: subcontracting.
for (const name of PURCHASING_SUBCONTRACT_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-44: supplier claims.
for (const name of PURCHASING_CLAIMS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-22: MRP every day.
for (const name of [...PLANNING_FIRM_PERMISSIONS, ...PLANNING_EXCEPTIONS_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-34: the planning board.
for (const name of PLANNING_SCHEDULE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-18: the reason lists.
for (const name of REASONS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-19: payment terms and price lists.
for (const name of [...PAYMENT_TERMS_PERMISSIONS, ...PRICE_LISTS_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-20: tasks on any record.
for (const name of TASKS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-26: defects, dispositions, holds.
for (const name of [...QUALITY_DEFECTS_PERMISSIONS, ...QUALITY_HOLDS_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-47: nonconformances.
for (const name of QUALITY_NCR_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-23: saved views and exports.
for (const name of VIEWS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-31: receiving every day.
for (const name of INVENTORY_DISCREPANCIES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-94: hides as stock.
for (const name of INVENTORY_HIDES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-100: one shade lot per order.
for (const name of INVENTORY_SHADE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-326: transfers between sites.
for (const name of INVENTORY_TRANSFERS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-32: global search.
for (const name of SEARCH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-168: portal search, flagged partner (never in an office or floor role).
for (const name of PORTAL_SEARCH_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-176: subcontractor jobs in the portal, flagged partner (never in an office or floor role).
for (const name of PORTAL_JOBS_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2a-35: the plant.
for (const name of PLANT_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-33: exception rules and stored alerts.
for (const name of ALERTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-39: the accounting exports and the period locks.
for (const name of ACCOUNTING_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-201: accountant access (the office's; the portal's flagged partner).
for (const name of ACCOUNTANTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of PORTAL_ACCOUNTING_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2a-36: Security & health.
for (const name of SECURITY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-43: customer returns.
for (const name of SALES_RETURNS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-38: production reports.
for (const name of PRODUCTION_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-41: the mail delivery log and the blocked addresses.
for (const name of EMAIL_DELIVERY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-48: shipping every day.
for (const name of SHIPPING_DAILY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-57: repairs and alterations.
for (const name of SALES_REPAIRS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-55: receivables.
for (const name of RECEIVABLES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-62: payables.
for (const name of PAYABLES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-65: customer complaints.
for (const name of QUALITY_COMPLAINTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-79: the report library.
for (const name of HOME_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-14: the Owner's switch for automatic PO confirmation reminders.
for (const name of PURCHASING_REMINDERS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-24: the controlled override of a migrated document's number.
for (const name of NUMBERING_OVERRIDE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-26: people.
for (const name of [...PEOPLE_EMPLOYEES_PERMISSIONS, ...PEOPLE_TEAMS_PERMISSIONS, ...PEOPLE_LEAVERS_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-27: privacy of people data.
for (const name of PEOPLE_PRIVACY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-29: off-standard and indirect time.
for (const name of PRODUCTION_OFFSTANDARD_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-35: help calls.
for (const name of PRODUCTION_CALLS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-32: shifts and overtime requests.
for (const name of PEOPLE_SHIFTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-46: checks before a scan counts.
for (const name of PRODUCTION_GUARDS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-47: more on the tablet.
for (const name of [...PRODUCTION_ONBEHALF_PERMISSIONS, ...PRODUCTION_EXTRAOPS_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-39: skills and machine authorisations.
for (const name of PEOPLE_SKILLS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-34: piece rates and the legal switch of piece pay.
for (const name of PEOPLE_PIECERATES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-33: clock in and out.
for (const name of PEOPLE_CLOCK_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-37: attendance days.
for (const name of PEOPLE_ATTENDANCE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-44: efficiency.
for (const name of PEOPLE_EFFICIENCY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-42: overtime worked, timesheets, working-time limits.
for (const name of [...PEOPLE_OVERTIME_PERMISSIONS, ...PEOPLE_LIMITS_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-48: the month close.
for (const name of PEOPLE_CLOSE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-43: earnings and pay periods.
for (const name of PEOPLE_EARNINGS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-54: the payroll export.
for (const name of PEOPLE_PAYROLL_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-45: labour records and corrections.
for (const name of PRODUCTION_LABOUR_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-50: line targets and boards.
for (const name of PRODUCTION_BOARDS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of PRODUCTION_DISPATCH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-93: AQL profiles and the AQL calculator.
for (const name of QUALITY_AQL_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-92: inspection plans.
for (const name of QUALITY_PLANS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-101: inspection triggers.
for (const name of QUALITY_TRIGGERS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-98: the incoming inspection.
for (const name of QUALITY_INCOMING_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-99: in-process checks.
for (const name of QUALITY_INPROCESS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-107: rolls, protector lots and consumables.
for (const name of INVENTORY_ROLLS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-108: corrective actions, CAPA and 8D.
for (const name of QUALITY_CAPA_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-124: statutory periodic checks of machines.
for (const name of PLANT_CHECKS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-123: amendments and the quality documents.
for (const name of [...QUALITY_AMENDMENTS_PERMISSIONS, ...QUALITY_DOCUMENTS_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-120: the safety organisation and the safety calendar.
for (const name of [...SAFETY_PERMISSIONS, ...SAFETY_CALENDAR_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-118: quality rules.
for (const name of QUALITY_RULES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-126: the repair station and second quality.
for (const name of PRODUCTION_REPAIR_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-122: the risk assessment, the DVR.
for (const name of SAFETY_RISK_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-125: incidents.
for (const name of SAFETY_INCIDENTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-138: quality reports.
for (const name of QUALITY_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-128: role sheets.
for (const name of SAFETY_ROLESHEETS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-135: health surveillance.
for (const name of SAFETY_HEALTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-132: the leather and cut plan.
for (const name of PLANNING_LEATHER_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-133: the course catalogue and training requirements.
for (const name of SAFETY_TRAINING_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-134: PPE for workers.
for (const name of SAFETY_PPE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-143: the chemical register and the safety data sheets.
for (const name of SAFETY_CHEMICALS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-139: training records, attendance and the instruction register.
for (const name of SAFETY_RECORDS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-161: company branding.
for (const name of BRANDING_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-162: partner organisations and the portal's own (each portal one flagged partner: never in an office or floor role).
for (const name of PARTNERS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of PORTAL_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-167: the partner's Home (partner roles only) and the office's requests to partners.
for (const name of PORTAL_HOME_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
for (const name of PARTNER_TASKS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-175: customer orders in the portal (partner roles only).
for (const name of PORTAL_SALES_ORDERS_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-174: supplier orders in the portal (partner roles only).
for (const name of PORTAL_PURCHASE_ORDERS_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-182: ship notices in the portal (partner roles only).
for (const name of PORTAL_SHIP_NOTICES_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-177: required documents.
for (const name of REQUIRED_DOCUMENTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-185: paying in the customer portal, flagged partner.
for (const name of PORTAL_PAYMENTS_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-178: customer documents in the portal (partner roles only).
for (const name of PORTAL_CUSTOMER_DOCUMENTS_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-190: portal ordering (partner roles only).
for (const name of PORTAL_ORDERING_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-183: change and cancel requests from the portal (partner roles only).
for (const name of PORTAL_ORDER_CHANGES_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-189: supplier documents and profile in the portal, flagged partner; the office's check.
for (const name of PORTAL_SUPPLIER_PROFILE_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
for (const name of SUPPLIER_REVIEW_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-192: returns and complaints from outside (partner roles only).
for (const name of PORTAL_RETURNS_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-184: approval requests to partners (the office's; the portal's flagged partner).
for (const name of PARTNERS_APPROVALS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of PORTAL_APPROVALS_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-200: inviting a partner to one record (the office's).
for (const name of PARTNERS_SHARES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-112: cut orders and cut tickets.
for (const name of PRODUCTION_CUTORDERS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-117: after the cut.
for (const name of PRODUCTION_CUTISSUE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-171: measurements by link.
for (const name of SALES_MEASUREMENTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-172: the supplier questionnaire.
for (const name of QUESTIONNAIRE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-208: the textile, leather and origin checks.
for (const name of TEXTILE_RULES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-214: work instructions.
for (const name of PRODUCTION_INSTRUCTIONS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-215: SMV governance.
for (const name of PRODUCT_SMV_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-221: the style lifecycle and the product settings.
for (const name of PRODUCT_LIFECYCLE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-227: GTINs from the company's own GS1 range.
for (const name of PRODUCT_GTINS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-226: change requests and change orders.
for (const name of PRODUCT_CHANGES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-229: the option library and option prices.
for (const name of PRODUCT_OPTIONS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-238: materials in depth.
for (const name of PRODUCT_MATERIALS_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-249: Rules & markets and the phrase library.
for (const name of [...RULES_LIBRARY_PERMISSIONS, ...PHRASES_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-254
for (const name of REQUIREMENTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-230: the tech pack PDF.
for (const name of PRODUCT_TECHPACKS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-233: prepacks.
for (const name of PRODUCT_PREPACKS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-250: restricted substances and their rules.
for (const name of SUBSTANCES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-246: sample rounds.
for (const name of SALES_SAMPLES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-251: technical files.
for (const name of TECHFILES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-257: the DoC generator.
for (const name of DECLARATIONS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-252: sample decisions.
for (const name of SALES_SAMPLE_DECISIONS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-260: recall, withdrawal and authority.
for (const name of RECALL_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-258: the user information builder.
for (const name of USER_INFORMATION_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-256: supplier declarations.
for (const name of SUPPLIER_DECLARATIONS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-259: label artwork.
for (const name of LABEL_ARTWORK_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-272: compliance reports.
for (const name of COMPLIANCE_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-263: Time & action.
for (const name of PLANNING_MILESTONES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-319: the production strategy per item.
for (const name of PLANNING_STRATEGY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-294: quote templates.
for (const name of QUOTE_TEMPLATES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-248: made-to-measure rules.
for (const name of PRODUCT_MTM_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-264: sourcing & claims.
for (const name of CLAIMS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-262: the brand's samples and tech packs (a partner permission).
for (const name of PORTAL_SAMPLES_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-247: the colour library and the branding sets.
for (const name of [...PRODUCT_COLOURS_PERMISSIONS, ...PRODUCT_BRANDING_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-282: one approval engine.
for (const name of APPROVALS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-296: purchase orders in depth.
for (const name of PO_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-332: ask to buy.
for (const name of ASK_TO_BUY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-288: the PPE text approvals.
for (const name of PPE_TEXTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-313: lots in depth.
for (const name of INVENTORY_LOTS_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-290: customers in depth.
for (const name of [...PARTIES_HOLD_PERMISSIONS, ...PARTIES_PRIVACY_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-295: inquiries.
for (const name of SALES_INQUIRIES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-314: the warehouse rules.
for (const name of INVENTORY_RULES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-293: planned work and subcontract orders.
for (const name of PLANNING_PLANNED_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of PLANNING_PROMISE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-312: scheduling in depth.
for (const name of PLANNING_SCHEDULE_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-317: the backlog ranked.
for (const name of PLANNING_BACKLOG_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-306
for (const name of PLANNING_ACTIONS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-321: work to subcontractors.
for (const name of PLANNING_SUBCONTRACT_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-311: suppliers in depth.
for (const name of SUPPLIERS_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-292: the warehouse task inbox.
for (const name of INVENTORY_TASKS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-331: subcontracting in depth.
for (const name of SUBCONTRACT_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-356: warehouse reports.
for (const name of INVENTORY_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-300: goods without a PO.
for (const name of INVENTORY_UNPLANNED_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-315: bank details, qualification and the compliance gate; the portal's bank permissions flagged partner.
for (const name of [...BANK_PERMISSIONS, ...QUALIFICATION_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of PORTAL_BANK_PERMISSIONS) if (FACTORY_PERMISSIONS.get(name)?.partner !== true) throw new Error(`${name} is a partner permission but not declared as one`)
// B-W2b-350: purchasing reports.
for (const name of PURCHASING_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-349: planning reports.
for (const name of PLANNING_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-348: sales reports.
for (const name of SALES_REPORTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-299: counts in depth.
for (const name of INVENTORY_COUNTS_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-304: credit limits.
for (const name of SALES_CREDIT_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-345: warranty and service cases.
for (const name of SALES_SERVICE_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-351: product-safety reports and the accident log.
for (const name of SALES_SAFETY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-358: the made-to-measure office.
for (const name of SALES_MTM_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-360: fittings, alterations and remakes.
for (const name of SALES_FITTINGS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-384: packing in depth.
for (const name of SHIPPING_PACKAGING_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-386: the shipment queue in depth.
for (const name of SHIPPING_HOLDS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-391: labels and documents.
for (const name of SHIPPING_PROFORMA_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-385: the notification defaults of each office role.
for (const name of NOTIFICATION_DEFAULTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-389: currencies and exchange rates.
for (const name of CURRENCY_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-392: tax rules as data.
for (const name of TAX_RULES_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-393: bank statements, matching and write-offs.
for (const name of [...PAYMENTS_BANK_PERMISSIONS, ...WRITE_OFF_PERMISSIONS]) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2b-394: team inboxes and the capture address.
for (const name of MAIL_DEPTH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of LINK_SESSION_NAMES) {
  if (FACTORY_PERMISSIONS.get(name)?.link !== true) throw new Error(`${name} is a link-session permission but not declared as one`)
}
