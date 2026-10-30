import { CALENDARS_DEFINITIONS, CALENDARS_PERMISSIONS } from '../../calendars/permissions'
// B-W2a-18: the reason lists (reasons.view, reasons.manage).
import { REASONS_DEFINITIONS, REASONS_PERMISSIONS } from '../../reasons/permissions'
import { CERTIFICATES_PERMISSIONS } from '../../compliance/certificates/permissions'
import { REGISTER_PERMISSIONS } from '../../compliance/register/permissions'
import { COSTING_DEFINITIONS, COSTING_PERMISSIONS } from '../../costing/permissions'
import { FLOOR_SYNC_DEFINITIONS, FLOOR_SYNC_PERMISSIONS } from '../../floor-sync/permissions'
import { HOME_DEFINITIONS, HOME_PERMISSIONS } from '../../insights/permissions'
import { TASKS_DEFINITIONS, TASKS_PERMISSIONS } from '../../tasks/permissions'
// B-W2a-33: exception rules and stored alerts.
import { ALERTS_DEFINITIONS, ALERTS_PERMISSIONS } from '../../alerts/permissions'
import type { Permission } from '../../core/permissions'
import { INVENTORY_FLOOR_PERMISSIONS, INVENTORY_PERMISSIONS } from '../../inventory/permissions'
import { INVENTORY_COUNTS_DEFINITIONS, INVENTORY_COUNTS_PERMISSIONS } from '../../inventory/counts/permissions'
// B-W2a-31: receiving every day (discrepancies and the report to the supplier).
import { INVENTORY_DISCREPANCIES_DEFINITIONS, INVENTORY_DISCREPANCIES_PERMISSIONS } from '../../inventory/receipts/permissions'
import { INVENTORY_RESERVATION_PERMISSIONS } from '../../inventory/reservations/permissions'
import { INVOICES_DEFINITIONS, INVOICES_PERMISSIONS } from '../../invoicing/permissions'
import { LINK_SESSION_PERMISSIONS as LINK_SESSION_NAMES, LINKS_OFFICE_PERMISSIONS } from '../../links/permissions'
import { NUMBERING_MANAGE, NUMBERING_VIEW } from '../../numbering/permissions'
import { PARTIES_DEFINITIONS, PARTIES_PERMISSIONS } from '../../parties/permissions'
import { PAYMENTS_DEFINITIONS, PAYMENTS_PERMISSIONS } from '../../payments/permissions'
import { PLANNING_DEFINITIONS, PLANNING_PERMISSIONS } from '../../planning/permissions'
import { PLANNING_SETTINGS_DEFINITIONS, PLANNING_SETTINGS_PERMISSIONS } from '../../planning/settings/permissions'
// B-W2a-22: MRP every day (planning.firm, planning.exceptions.manage).
import { PLANNING_EXCEPTIONS_DEFINITIONS, PLANNING_EXCEPTIONS_PERMISSIONS } from '../../planning/exceptions/permissions'
import { PLANNING_FIRM_DEFINITIONS, PLANNING_FIRM_PERMISSIONS } from '../../planning/mrp/permissions'
// B-W2a-34: the planning board (planning.schedule.manage, planning.schedule.publish).
import { PLANNING_SCHEDULE_DEFINITIONS, PLANNING_SCHEDULE_PERMISSIONS } from '../../planning/schedule/permissions'
import { PURCHASING_DEFINITIONS, PURCHASING_PERMISSIONS } from '../../purchasing/permissions'
import { PURCHASING_SOURCES_DEFINITIONS, PURCHASING_SOURCES_PERMISSIONS } from '../../purchasing/sources/permissions'
// B-W2a-25: subcontracting (purchasing.subcontract.manage | kit | receive).
import { PURCHASING_SUBCONTRACT_DEFINITIONS, PURCHASING_SUBCONTRACT_PERMISSIONS } from '../../purchasing/subcontracting/permissions'
// B-W2a-44: supplier claims and returns to the supplier (purchasing.claims.manage | return).
import { PURCHASING_CLAIMS_DEFINITIONS, PURCHASING_CLAIMS_PERMISSIONS } from '../../purchasing/claims/permissions'
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
// B-W2a-35: the plant (machines, machine requests, maintenance jobs).
import { PLANT_DEFINITIONS, PLANT_FLOOR_PERMISSIONS, PLANT_PERMISSIONS } from '../../plant/permissions'
// B-W2a-39: the accounting exports and the period locks (accounting.view | export | lock | unlock).
import { ACCOUNTING_DEFINITIONS, ACCOUNTING_PERMISSIONS } from '../../accounting/permissions'
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
// B-W2a-65: customer complaints (quality.complaints.view | log | manage | acknowledge).
import { QUALITY_COMPLAINTS_DEFINITIONS, QUALITY_COMPLAINTS_PERMISSIONS } from '../../quality/complaints/permissions'
import { GRAIN_DESCRIPTIONS, GRAINS, grainPermission } from '../grains/grains'
import { definePermissions, permissionRegistry, type PermissionDefinition } from './registry'

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
  // B-W2a-65: customer complaints (log, triage, the owner's acknowledgement of a safety alert).
  QUALITY_COMPLAINTS_DEFINITIONS,
  MONEY_PERMISSIONS,
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
  ...SALES_RETURNS_FLOOR_PERMISSIONS])

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
// B-W2a-32: global search.
for (const name of SEARCH_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-35: the plant.
for (const name of PLANT_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-33: exception rules and stored alerts.
for (const name of ALERTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
// B-W2a-39: the accounting exports and the period locks.
for (const name of ACCOUNTING_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
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
// B-W2a-65: customer complaints.
for (const name of QUALITY_COMPLAINTS_PERMISSIONS) if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
for (const name of LINK_SESSION_NAMES) {
  if (FACTORY_PERMISSIONS.get(name)?.link !== true) throw new Error(`${name} is a link-session permission but not declared as one`)
}
