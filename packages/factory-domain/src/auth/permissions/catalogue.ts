import { CERTIFICATES_PERMISSIONS } from '../../compliance/certificates/permissions'
import type { Permission } from '../../core/permissions'
import { INVENTORY_FLOOR_PERMISSIONS, INVENTORY_PERMISSIONS } from '../../inventory/permissions'
import { LINK_SESSION_PERMISSIONS as LINK_SESSION_NAMES, LINKS_OFFICE_PERMISSIONS } from '../../links/permissions'
import { NUMBERING_MANAGE, NUMBERING_VIEW } from '../../numbering/permissions'
import { PARTIES_DEFINITIONS, PARTIES_PERMISSIONS } from '../../parties/permissions'
import { PLANNING_DEFINITIONS, PLANNING_PERMISSIONS } from '../../planning/permissions'
import { PRODUCT_BOM_DEFINITIONS, PRODUCT_BOM_PERMISSIONS } from '../../product/bom/permissions'
import { PRODUCT_MATERIALS_DEFINITIONS, PRODUCT_MATERIALS_PERMISSIONS } from '../../product/materials/permissions'
import { PRODUCT_ROUTING_DEFINITIONS, PRODUCT_ROUTING_PERMISSIONS } from '../../product/routing/permissions'
import { PRODUCT_STYLES_DEFINITIONS, PRODUCT_STYLES_PERMISSIONS } from '../../product/styles/permissions'
import { SHIPPING_DEFINITIONS, SHIPPING_FLOOR_PERMISSIONS, SHIPPING_PERMISSIONS } from '../../shipping/permissions'
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
 * Compliance: the EU type-examination certificate register (apps/factory-api modules/compliance/certificates; QHS-103,
 * QHS-051, PRD-288; Reg. (EU) 2016/425). Checked with can() against the certificate's company and holder party. The
 * constants live in factory-domain/src/compliance/certificates/permissions.ts. Not step-up: a certificate is typed from
 * the notified body's PDF, and registering one needs that PDF on the record.
 */
export const COMPLIANCE_DEFINITIONS = definePermissions('compliance', {
  'certificates.view': { risk: 'read', description: 'See the EU type-examination certificates, what they cover and when they expire; ask the certificate gate whether a garment is covered.' },
  'certificates.manage': { risk: 'write', description: 'Type in certificates, register them with their PDF, suspend, reinstate and withdraw them, and record or end what they cover.' },
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
  COMPLIANCE_DEFINITIONS,
  PRODUCT_MATERIALS_DEFINITIONS,
  PRODUCT_STYLES_DEFINITIONS,
  PRODUCT_BOM_DEFINITIONS,
  PRODUCT_ROUTING_DEFINITIONS,
  INVENTORY_DEFINITIONS,
  SHIPPING_DEFINITIONS,
  PARTIES_DEFINITIONS,
  PLANNING_DEFINITIONS,
  MONEY_PERMISSIONS,
])

/** The area of the permissions only floor roles hold (and floor roles hold no other, but FLOOR_SHARED_PERMISSIONS). */
export const FLOOR_AREA = 'floor'

/**
 * The office permissions a floor role may hold too: what a floor device does on the same routes as the office, at its
 * own device's site only (can() pins a floor session to it, row-level security too). Printing labels at the site's
 * printer (GAP-007) and seeing its print queue; seeing the site's locations and moving stock between them (SCM-176,
 * SCM-189); packing the site's shipments (LOG-039, SCR-098). Never a money grain; floor roles still hold no other office
 * permission.
 */
export const FLOOR_SHARED_PERMISSIONS: readonly Permission[] = Object.freeze([PRINT_VIEW, PRINT_LABELS, ...INVENTORY_FLOOR_PERMISSIONS, ...SHIPPING_FLOOR_PERMISSIONS])

// The modules' constants and their declarations name the same permissions.
for (const name of [NUMBERING_VIEW, NUMBERING_MANAGE, FILES_READ, FILES_UPLOAD, FILES_DELETE, FILES_MANAGE, ...LINKS_OFFICE_PERMISSIONS, THREADS_READ, THREADS_POST, THREADS_MANAGE, IMPORTS_VIEW, IMPORTS_RUN, IMPORTS_APPLY, DOCUMENTS_VIEW, PRINT_VIEW, PRINT_LABELS, PRINT_DOCUMENTS, PRINT_MANAGE, EMAIL_SEND, EMAIL_MANAGE, EMAIL_TRIAGE, ...CERTIFICATES_PERMISSIONS, ...PRODUCT_MATERIALS_PERMISSIONS, ...INVENTORY_PERMISSIONS, ...PRODUCT_STYLES_PERMISSIONS, ...PRODUCT_BOM_PERMISSIONS, ...PRODUCT_ROUTING_PERMISSIONS, ...SHIPPING_PERMISSIONS, ...PARTIES_PERMISSIONS, ...PLANNING_PERMISSIONS]) {
  if (!FACTORY_PERMISSIONS.isDeclared(name)) throw new Error(`${name} is used by a module but not declared`)
}
for (const name of LINK_SESSION_NAMES) {
  if (FACTORY_PERMISSIONS.get(name)?.link !== true) throw new Error(`${name} is a link-session permission but not declared as one`)
}
