import type { Permission } from '../../core/permissions'
import { GRAINS, isGrain, type Grain } from '../grains/grains'
import { FACTORY_PERMISSIONS, FLOOR_AREA, FLOOR_SHARED_PERMISSIONS } from '../permissions/catalogue'

/**
 * The system role templates (plan A1 §3.11 "Role"; feature PLT-030): ready roles every tenant gets as system roles
 * (Role rows with `system` set, kept equal to these by the API's syncSystemRoles). A tenant cannot edit a system
 * role; it copies one into a custom role and edits the copy. A later change of a template reaches the system roles
 * through a sync (audited per tenant) and NEVER a custom copy: the role screens show what the template has that the
 * copy lacks (`templateAdds`), and adding it is an explicit, audited edit.
 *
 * Office roles (B-W0-15) and floor roles (B-W0-16, audience `floor`: given to floor workers, never to office users,
 * and held only by a floor session on an enrolled device). A floor role holds only `floor.*` permissions, sees at
 * most wages and never requires two-factor (the device and the PIN are the floor's factors); an office role holds no
 * `floor.*` permission. The few office permissions the floor uses on the same routes, at its own site only
 * (FLOOR_SHARED_PERMISSIONS: printing labels, the site's locations and transfers between them, picking and issuing to the
 * site's work orders, cutting hides for them and bundling their pieces, packing shipments), are the exception a floor role may hold. Each module
 * step adds its new permissions to the templates that need them. The owner holds
 * every declared office permission and the read-only role every office `read` one, so they follow the registry by
 * themselves.
 *
 * `requireMfa`: a session holds none of the role's permissions until two-factor was proved on it (A1 §3.10: owner,
 * admin, finance; and every role that sees costs or margins).
 */

export const ROLE_AUDIENCES = ['office', 'floor'] as const
export type RoleAudience = (typeof ROLE_AUDIENCES)[number]

/** What a role gives. */
export interface RoleContent {
  readonly name: string
  readonly description: string
  readonly requireMfa: boolean
  readonly permissions: readonly Permission[]
  readonly grains: readonly Grain[]
}

export interface RoleTemplate extends RoleContent {
  /** Lower snake case; the system role's key in every tenant. Custom roles' keys start with `custom.` and never clash. */
  readonly key: string
  readonly audience: RoleAudience
}

const assignable = FACTORY_PERMISSIONS.assignable.filter((definition) => definition.area !== FLOOR_AREA)
const every = (filter: (risk: string) => boolean = () => true): Permission[] =>
  assignable.filter((definition) => filter(definition.risk)).map((definition) => definition.name)

/**
 * B-W2a-20 (tasks on any record, COL-037): every office template that writes notes on records (threads.post) makes and
 * keeps tasks too. Listed here, one line per template, so the long permission lists below stay as their steps wrote them.
 */
const TASKS_TEMPLATES: ReadonlySet<string> = new Set(['admin', 'finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor'])
/**
 * B-W2a-35 (the plant; QHS-162, QHS-178, QHS-184; Owner answer H1): who sees and works the machines, requests and jobs,
 * one line per template. Every floor role reports a machine problem (H1: anyone at the station marks a machine unsafe at
 * once); only the technicians' templates (`maintenance`, `technician`, below) sign a machine safe again.
 */
const PLANT_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: ['plant.view'],
  production_manager: ['plant.view', 'plant.machines.manage', 'plant.report', 'plant.requests.triage', 'plant.jobs.manage'],
  floor_supervisor: ['plant.view', 'plant.report', 'plant.requests.triage'],
  operator: ['plant.report'],
  cutting_operator: ['plant.report'],
  floor_inspector: ['plant.report'],
  team_leader: ['plant.report'],
})
/**
 * B-W2a-43 (customer returns; design sales.returns, floor.returnsin): sales makes the RMA and decides what the customer
 * gets (credit values with its price grain); the warehouse receives at the dock and grades with the quality inspector;
 * finance and production read them (finance makes the credit note, B-W2a-61). On the floor the dock's operator and team
 * leader receive, the floor inspector receives and grades. Owner and read-only take theirs from every().
 */
const RETURNS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: ['sales.returns.view', 'sales.returns.manage', 'sales.returns.decide'],
  finance: ['sales.returns.view'],
  warehouse: ['sales.returns.view', 'sales.returns.receive', 'sales.returns.inspect'],
  quality_inspector: ['sales.returns.view', 'sales.returns.inspect'],
  production_manager: ['sales.returns.view'],
  operator: ['sales.returns.receive'],
  team_leader: ['sales.returns.receive'],
  floor_inspector: ['sales.returns.receive', 'sales.returns.inspect'],
})
/**
 * B-W2a-57 (repairs and alterations; design sales.returns "Repair order"): sales makes the repair and moves its stages
 * (and takes the garment in at the counter); the production manager moves it too (its repair work order is theirs); the
 * warehouse receives the garment at the dock and sends it back with its DDT (it issues DDTs); the quality inspector signs
 * a protective garment's safety check; finance reads them. Office only (the floor reads no repair yet). Owner and
 * read-only take theirs from every().
 */
const REPAIRS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: ['sales.repairs.view', 'sales.repairs.manage', 'sales.repairs.receive'],
  production_manager: ['sales.repairs.view', 'sales.repairs.manage'],
  warehouse: ['sales.repairs.view', 'sales.repairs.receive', 'sales.repairs.ship'],
  quality_inspector: ['sales.repairs.view', 'sales.repairs.check'],
  finance: ['sales.repairs.view'],
})
const repairsAddedFor = (key: string, audience: RoleAudience): readonly Permission[] => (audience === 'office' ? (REPAIRS_ADDS[key] ?? []) : [])
/**
 * B-W2a-48 (shipping every day; LOG-105, LOG-090): finance sets the freight charged (a price: its grain) and says when a
 * shipment's intra-EU transport evidence is enough; the warehouse files the carrier's papers. Owner takes them from every().
 */
const SHIPPING_DAILY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: ['shipping.freight.manage', 'shipping.evidence.manage'],
  warehouse: ['shipping.evidence.manage'],
})
/**
 * B-W2a-47 (nonconformances, QHS-080 … QHS-091; design quality.ncr): whoever finds a problem raises an NCR from where
 * they work (the warehouse at a lot or a receipt, the buyer at a supplier claim, sales at a return, the floor
 * supervisor at a bundle); quality follows it up, approves another person's decisions and closes it with an
 * e-signature; the production manager follows up and approves too (rework and scrap of the work orders); the planner
 * reads them. Office only; owner and read-only take theirs from every().
 */
const NCR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.ncr.view', 'quality.ncr.raise', 'quality.ncr.manage', 'quality.ncr.approve', 'quality.ncr.close'],
  production_manager: ['quality.ncr.view', 'quality.ncr.raise', 'quality.ncr.manage', 'quality.ncr.approve'],
  floor_supervisor: ['quality.ncr.view', 'quality.ncr.raise'],
  warehouse: ['quality.ncr.view', 'quality.ncr.raise'],
  buyer: ['quality.ncr.view', 'quality.ncr.raise'],
  sales: ['quality.ncr.view', 'quality.ncr.raise'],
  planner: ['quality.ncr.view'],
})
/**
 * B-W2a-55 (receivables, FIN-109 … FIN-111; design finance.receivables, the Finance area's people): finance reads the
 * ageing and statements, prepares, edits, approves and sends the reminders, e-mails statements and keeps the ladder.
 * The Owner's switch (receivables.reminders.switch, step-up) is the owner's alone, through every(); read-only gets
 * receivables.view through the registry. B-W2a-81: sales reads it too (design sales.customers "Overdue (price, W2a)" on
 * the customer list and record, and Finance › Receivables from the customer), never a reminder move.
 */
const RECEIVABLES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: ['receivables.view', 'receivables.reminders.manage', 'receivables.reminders.approve', 'receivables.statements.send', 'receivables.settings.manage'],
  sales: ['receivables.view'],
})
/**
 * B-W2a-65 (customer complaints; SAL-416, QHS-113, QHS-115; design quality.complaints): sales logs what the customer said
 * (the intake is SAL's) and follows its complaints; quality triages, investigates, answers and closes them (a safety one
 * alerts the owner and quality and opens its PPE register entry); the production manager reads them and logs one found
 * on the floor. The owner's acknowledgement of a safety alert (quality.complaints.acknowledge) is the owner's alone,
 * through every(); read-only reads them through the registry.
 */
const COMPLAINTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: ['quality.complaints.view', 'quality.complaints.log'],
  quality_inspector: ['quality.complaints.view', 'quality.complaints.log', 'quality.complaints.manage'],
  production_manager: ['quality.complaints.view', 'quality.complaints.log'],
})
// B-W2a-61 (FIN-127; design finance.payments "Refund"): finance records the refunds to customers (money out).
const REFUNDS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: ['payments.refund'],
})
/**
 * B-W2a-62 (payables, FIN-136 / FIN-137; design finance.payables, the Finance area's people): finance registers, maps,
 * matches, approves and pays supplier invoices; the buyer maps lines to its orders, sends and accepts the differences
 * ("Differences go to the buyer before payment") and may type a foreign invoice, but never approves or pays. Approval is
 * never by who registered the invoice (the API and the …_money_w2a_guards). Read-only gets payables.view through the
 * registry; the owner every one through every().
 */
const PAYABLES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: ['payables.view', 'payables.manage', 'payables.differences.accept', 'payables.approve', 'payables.pay'],
  buyer: ['payables.view', 'payables.manage', 'payables.differences.accept'],
})
/**
 * B-W2a-F4 (Owner answer 1A, 2026-10-30): asking a supplier for a receipt's missing documents is one narrow action of its
 * own, NOT email.send: the warehouse and every template that keeps receipt discrepancies (buyer). Owner from every().
 */
const RECEIPT_DOCUMENTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: ['inventory.receipts.documents.request'],
  buyer: ['inventory.receipts.documents.request'],
})
/**
 * B-W2a-76 (design floor.kits; SCM-140, SCM-142): on the floor the warehouse tablet's operator and team leader send a
 * subcontract kit (with its DDT for work on our behalf) and receive the goods back, bundle by bundle. Floor only: the
 * office warehouse holds both already (B-W2a-25). Never a fee.
 */
const SUBCONTRACT_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  operator: ['purchasing.subcontract.kit', 'purchasing.subcontract.receive'],
  team_leader: ['purchasing.subcontract.kit', 'purchasing.subcontract.receive'],
})
/**
 * B-W2b-21 (Z8:03; the payables settings: the accountant's tolerances and billing basis, who approves what SDI delivered):
 * finance keeps them, as it keeps the receivables settings. The owner from every().
 */
const PAYABLES_SETTINGS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: ['payables.settings'],
})
const addedFor = (key: string, audience: RoleAudience): Permission[] => [...(audience === 'office' && TASKS_TEMPLATES.has(key) ? ['tasks.manage' as Permission] : []), ...(PLANT_ADDS[key] ?? []), ...(RETURNS_ADDS[key] ?? []), ...(SHIPPING_DAILY_ADDS[key] ?? []), ...(audience === 'office' ? (NCR_ADDS[key] ?? []) : []),
  // B-W2a-55
  ...(audience === 'office' ? (RECEIVABLES_ADDS[key] ?? []) : []),
  // B-W2a-76
  ...(audience === 'floor' ? (SUBCONTRACT_FLOOR_ADDS[key] ?? []) : []),
  // B-W2a-61
  ...(audience === 'office' ? (REFUNDS_ADDS[key] ?? []) : []),
  // B-W2a-62
  ...(audience === 'office' ? (PAYABLES_ADDS[key] ?? []) : []),
  // B-W2a-65
  ...(audience === 'office' ? (COMPLAINTS_ADDS[key] ?? []) : []),
  // B-W2a-F4
  ...(audience === 'office' ? (RECEIPT_DOCUMENTS_ADDS[key] ?? []) : []),
  // B-W2b-21
  ...(audience === 'office' ? (PAYABLES_SETTINGS_ADDS[key] ?? []) : [])]
/**
 * B-W2a-33 (exception rules and stored alerts, ANA-036; design home.alerts): every office template that sees Today sees and
 * handles the alerts of the records it sees (each alert is also behind its record's own view permission); the
 * administrator and the production manager keep the rules. Listed here, one line per template, as tasks are.
 */
const ALERTS_TEMPLATES: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['alerts.view', 'alerts.handle', 'alerts.rules.manage'],
  finance: ['alerts.view', 'alerts.handle'],
  sales: ['alerts.view', 'alerts.handle'],
  planner: ['alerts.view', 'alerts.handle'],
  buyer: ['alerts.view', 'alerts.handle'],
  warehouse: ['alerts.view', 'alerts.handle'],
  production_manager: ['alerts.view', 'alerts.handle', 'alerts.rules.manage'],
  quality_inspector: ['alerts.view', 'alerts.handle'],
  floor_supervisor: ['alerts.view', 'alerts.handle'],
})
const alertsAddedFor = (key: string, audience: RoleAudience): readonly Permission[] => (audience === 'office' ? (ALERTS_TEMPLATES[key] ?? []) : [])
/**
 * B-W2a-38 (production reports, MES-301 / MES-160; design production.reports): who reads the daily production report
 * per line, style and size and has it e-mailed each morning, to themselves and (subscribe) to colleagues who may read
 * it. Office only, never a floor role; one line per template.
 */
const REPORTS_TEMPLATES: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: ['production.reports.view', 'production.reports.subscribe'],
  production_manager: ['production.reports.view', 'production.reports.subscribe'],
  quality_inspector: ['production.reports.view'],
  floor_supervisor: ['production.reports.view', 'production.reports.subscribe'],
})
const reportsAddedFor = (key: string, audience: RoleAudience): readonly Permission[] => (audience === 'office' ? (REPORTS_TEMPLATES[key] ?? []) : [])
/**
 * B-W2a-79 (the report library, ANA-029 / ANA-034; design home.reports): every office template that works with business
 * records runs the standard reports; each report shows only what the person's other permissions and grains reach. The
 * administrator sees no business data and gets none; the owner and read_only follow the registry. One line per template.
 */
const REPORT_LIBRARY_TEMPLATES: ReadonlySet<string> = new Set(['finance', 'sales', 'planner', 'buyer', 'warehouse', 'production_manager', 'quality_inspector', 'floor_supervisor'])
const reportLibraryAddedFor = (key: string, audience: RoleAudience): readonly Permission[] => (audience === 'office' && REPORT_LIBRARY_TEMPLATES.has(key) ? ['home.reports.view' as Permission] : [])

const template = (key: string, content: Omit<RoleTemplate, 'key' | 'audience'>, audience: RoleAudience = 'office'): RoleTemplate =>
  Object.freeze({ key, audience, ...content, permissions: Object.freeze([...new Set([...content.permissions, ...addedFor(key, audience), ...alertsAddedFor(key, audience), ...reportsAddedFor(key, audience), ...repairsAddedFor(key, audience), ...reportLibraryAddedFor(key, audience)])].sort()), grains: Object.freeze([...content.grains]) })
const floorTemplate = (key: string, content: Omit<RoleTemplate, 'key' | 'audience' | 'requireMfa'>): RoleTemplate =>
  template(key, { ...content, requireMfa: false }, 'floor')

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze([
  template('owner', {
    name: 'Owner',
    description: 'Everything, in every company, including every money figure. The tenant always keeps one.',
    requireMfa: true,
    permissions: every(),
    grains: GRAINS,
  }),
  template('admin', {
    name: 'Administrator',
    description: 'People, roles and the audit log; sees no money unless also given a role that does.',
    requireMfa: true,
    permissions: [
      'companies.view',
      'companies.manage',
      'sites.view',
      'sites.manage',
      'users.view',
      'users.invite',
      'users.suspend',
      'users.reactivate',
      'users.deactivate',
      'users.resetPassword',
      'roles.view',
      'roles.manage',
      'roles.assign',
      'audit.read',
      'numbering.view',
      'files.read',
      'files.upload',
      'files.manage',
      'files.delete',
      'devices.view',
      'devices.manage',
      'devices.revoke',
      'workers.view',
      'workers.manage',
      'workers.roles',
      'workers.credentials',
      'threads.read',
      'threads.post',
      'threads.manage',
      'imports.view',
      'imports.run',
      'imports.apply',
      'documents.view',
      'print.view',
      'print.manage',
      'email.send',
      'email.manage',
      'email.triage',
      'integrations.view',
      'integrations.manage',
      'companies.bank.view',
      'companies.bank.manage',
      'shipping.settings.view',
      'shipping.settings.manage',
      'production.settings.view',
      'privacy.view',
      'privacy.manage',
      'floorsync.view',
      'floorsync.discard',
      'home.view',
      'calendars.view',
      'calendars.manage',
      // B-W2a-18: the reason lists of the whole group.
      'reasons.view',
      'reasons.manage',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.manage', 'views.export',
      // B-W2a-32: rebuild the search index.
      'search.rebuild',
      // B-W2a-36: Security & health; record a restore drill.
      'security.view', 'security.drills.record',
      // B-W2a-41: the mail delivery log; unblock an address.
      'email.delivery.view', 'email.delivery.unblock',
    ],
    grains: [],
  }),
  template('finance', {
    name: 'Finance',
    description: 'Invoices, payments and number series; sees prices, costs, margins and wages.',
    requireMfa: true,
    permissions: ['numbering.view', 'numbering.manage', 'audit.read', 'files.read', 'files.upload', 'threads.read', 'threads.post', 'documents.view', 'print.view', 'print.documents', 'email.send', 'product.materials.view', 'product.materials.cost', 'product.styles.view', 'product.bom.view', 'product.routing.view', 'inventory.locations.view', 'inventory.stock.view', 'shipping.view', 'parties.view', 'parties.manage', 'parties.block', 'parties.vies', 'invoices.view', 'invoices.manage', 'invoices.issue', 'payments.view', 'payments.record', 'payments.void', 'costing.view', 'costing.rates.manage', 'quotes.view', 'quotes.approve', 'sales.settings.manage', 'companies.bank.view', 'companies.bank.manage', 'orders.view', 'orders.close', 'home.view', 'calendars.view', 'inventory.counts.view', 'inventory.counts.signoff', 'production.scrap.view',
      // B-W2a-21 (standard vs actual): standards, the cost ledger, the costing method (step-up).
      'costing.standards.manage', 'costing.ledger.manage', 'costing.method.manage',
      // B-W2a-18: the reason lists (return and cancel reasons beside the sales settings).
      'reasons.view',
      // B-W2a-19: the payment terms library (Finance settings) and the price lists (read).
      'paymentterms.view', 'paymentterms.manage', 'pricelists.view',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export',
      // B-W2a-39: the accounting exports and the period locks (lifting a hard lock, accounting.unlock, stays the owner's).
      'accounting.view', 'accounting.export', 'accounting.lock'],
    grains: ['price', 'cost', 'margin', 'wages'],
  }),
  template('sales', {
    name: 'Sales',
    // Design question S2 (what sales sees of cost), the Owner's answer a: margin % and "under the floor", never a cost
    // (the quotes API drops the margin AMOUNT without the cost grain). A role that sees margins requires two-factor
    // (A1 §3.10).
    description: 'Customers, quotes and orders; sees selling prices and margin %, not costs.',
    requireMfa: true,
    permissions: ['audit.read', 'files.read', 'files.upload', 'threads.read', 'threads.post', 'documents.view', 'print.view', 'print.documents', 'email.send', 'email.triage', 'product.materials.view', 'product.styles.view', 'shipping.view', 'imports.view', 'imports.run', 'imports.apply', 'parties.view', 'parties.manage', 'parties.vies', 'invoices.view', 'payments.view', 'costing.view', 'workorders.view', 'quotes.view', 'quotes.manage', 'quotes.send', 'orders.view', 'orders.manage', 'home.view', 'calendars.view',
      // B-W2a-19: the customer price lists (keep them) and the payment terms library (pick from it).
      'pricelists.view', 'pricelists.manage', 'paymentterms.view',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export'],
    grains: ['price', 'margin'],
  }),
  template('planner', {
    name: 'Planner',
    description: 'Plans work orders and capacity; sees no money.',
    requireMfa: false,
    permissions: ['files.read', 'files.upload', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'print.documents', 'product.materials.view', 'product.styles.view', 'product.bom.view', 'product.routing.view', 'compliance.certificates.view', 'inventory.locations.view', 'inventory.stock.view', 'inventory.reserve', 'shipping.view', 'planning.view', 'planning.run', 'planning.decide', 'purchasing.view', 'workorders.view', 'workorders.manage', 'workorders.release', 'orders.view', 'home.view', 'calendars.view', 'calendars.manage', 'calendars.suppliers.manage',
      // B-W2a-16: planning settings and capacity (horizon, efficiency, people per line) and item parameters.
      'planning.settings.manage', 'planning.items.manage',
      // B-W2a-13: scrap and rework (see), approve a lower order quantity.
      'production.scrap.view', 'production.scrap.approve',
      // B-W2a-22: firm planned orders and the exception list of the runs.
      'planning.firm', 'planning.exceptions.manage',
      // B-W2a-34: the planning board (moves into the shared working plan, allocation) and publishing it to the floor.
      'planning.schedule.manage', 'planning.schedule.publish',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export'],
    grains: [],
  }),
  template('buyer', {
    name: 'Buyer',
    description: 'Suppliers and purchase orders; sees purchase prices (the cost grain).',
    requireMfa: true,
    permissions: [
      'audit.read',
      'files.read',
      'files.upload',
      'threads.read',
      'threads.post',
      'documents.view',
      'print.view',
      'print.documents',
      'email.send',
      'email.triage',
      'imports.view',
      'imports.run',
      'imports.apply',
      'product.materials.view',
      'product.materials.manage',
      'product.materials.cost',
      'product.styles.view',
      'product.bom.view',
      'inventory.locations.view',
      'inventory.stock.view',
      'parties.view',
      'parties.manage',
      'parties.vies',
      'planning.view',
      'planning.run',
      'planning.decide',
      // B-W2a-16: lead times, safety stock, order minimum and step, preferred supplier per item and site.
      'planning.items.manage',
      // B-W2a-22: firm planned orders and the exception list of the runs.
      'planning.firm',
      'planning.exceptions.manage',
      'purchasing.view',
      'purchasing.manage',
      'purchasing.send',
      'costing.view',
      'quality.lots.view',
      'quality.lots.documents',
      'home.view',
      'calendars.view',
      'calendars.suppliers.manage',
      // B-W2a-10: the approved sources (supplier articles, units, prices, minimums, lead times).
      'purchasing.sources.manage',
      // B-W2a-25: subcontract orders to the workshops (operations, fees, kit plan, issue, cancel, close).
      'purchasing.subcontract.manage',
      // B-W2a-44: claims to suppliers (from discrepancies, lots or typed), sent by e-mail, answered, closed.
      'purchasing.claims.manage',
      // B-W2a-31: what was wrong with a delivery, its report to the supplier and its answer.
      'inventory.discrepancies.manage',
      'inventory.discrepancies.report',
      // W2a B-W2a-13 (MES-057): the hide yield per supplier lot feeds the supplier's rating.
      'production.cutting.view',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export',
    ],
    grains: ['cost'],
  }),
  template('warehouse', {
    name: 'Warehouse',
    description: 'Receiving, stock and shipping; sees no money.',
    requireMfa: false,
    permissions: [
      'files.read',
      'files.upload',
      'threads.read',
      'threads.post',
      'print.view',
      'print.labels',
      'print.documents',
      'imports.view',
      'imports.run',
      'imports.apply',
      'product.materials.view',
      'product.styles.view',
      'inventory.locations.view',
      'inventory.locations.manage',
      'inventory.stock.view',
      'inventory.adjust',
      'inventory.transfer',
      'inventory.scrap',
      'inventory.reverse',
      'inventory.issue',
      'inventory.issue.over',
      'inventory.receive',
      'inventory.opening.import',
      'inventory.counts.view',
      'inventory.counts.manage',
      'inventory.counts.approve',
      'inventory.reserve',
      // B-W2a-12: report finished garments to stock.
      'production.finish',
      'shipping.view',
      'shipping.manage',
      'shipping.pack',
      'shipping.settings.view',
      'shipping.settings.manage',
      'shipping.ddt.issue',
      'shipping.ddt.cancel',
      'shipping.labels.buy',
      'shipping.labels.void',
      'parties.view',
      'purchasing.view',
      // B-W2a-25: send a subcontract order's kit with its DDT, receive the goods back by bundle.
      'purchasing.subcontract.kit',
      'purchasing.subcontract.receive',
      // B-W2a-44: claims to suppliers, and the goods of a return sent back with the return DDT (Return to supplier).
      'purchasing.claims.manage',
      'purchasing.claims.return',
      'workorders.view',
      'orders.view',
      'quality.lots.view',
      'floorsync.view',
      'floorsync.discard',
      'home.view',
      // B-W2a-26: sees what is on hold (design quality.holds: warehouse and supervisors read).
      'quality.holds.view',
      // B-W2a-31: records what was wrong with a delivery at receiving and reports it to the supplier.
      'inventory.discrepancies.manage',
      'inventory.discrepancies.report',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export',
    ],
    grains: [],
  }),
  template('production_manager', {
    name: 'Production manager',
    description: 'Runs production: work orders, lines and floor results; sees no money.',
    requireMfa: false,
    permissions: [
      'audit.read',
      'files.read',
      'files.upload',
      'devices.view',
      'workers.view',
      'threads.read',
      'threads.post',
      'print.view',
      'print.labels',
      'print.documents',
      'imports.view',
      'imports.run',
      'imports.apply',
      'product.materials.view',
      'product.materials.manage',
      'product.styles.view',
      'product.styles.manage',
      'product.bom.view',
      'product.bom.manage',
      'product.bom.release',
      'product.routing.view',
      'product.routing.manage',
      'product.operations.manage',
      'compliance.certificates.view',
      'compliance.register.view',
      'inventory.locations.view',
      'inventory.stock.view',
      'inventory.transfer',
      'inventory.scrap',
      'inventory.issue',
      'inventory.issue.over',
      'inventory.reserve',
      'shipping.view',
      'planning.view',
      'costing.view',
      'production.settings.view',
      'production.settings.manage',
      'production.bundles',
      'production.cut',
      'production.cut.correct',
      'production.scan',
      'production.scan.correct',
      'production.serials',
      // B-W2a-12: report finished garments to stock.
      'production.finish',
      // W2a B-W2a-13: rework, scrap and its replacement, the cutting room's yield.
      'production.rework',
      'production.scrap.view',
      'production.scrap',
      'production.scrap.approve',
      'production.cutting.view',
      'workorders.view',
      'workorders.manage',
      'workorders.release',
      'orders.view',
      'quality.inspections.view',
      'floorsync.view',
      'floorsync.discard',
      'home.view',
      'calendars.view',
      // B-W2a-18: Floor rules & codes' reason lists (pause, scrap, rework, downtime, help calls …).
      'reasons.view',
      'reasons.manage',
      // B-W2a-26 (MES-008): puts work orders and bundles on hold; reads the defect library.
      'quality.holds.view',
      'quality.holds.place',
      'quality.defects.view',
      // B-W2b-29: off-standard and indirect time (MES-155 … MES-158): the codes of Floor rules & codes, the labour inbox's blocks.
      'production.offstandard.view', 'production.offstandard.codes', 'production.offstandard.approve',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export',
    ],
    grains: [],
  }),
  template('quality_inspector', {
    name: 'Quality inspector',
    description: 'Inspects lots and finished goods and releases them; sees no money.',
    requireMfa: false,
    permissions: ['files.read', 'files.upload', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'product.materials.view', 'product.styles.view', 'product.bom.view', 'product.routing.view', 'compliance.certificates.view', 'compliance.certificates.manage', 'compliance.declarations.manage', 'compliance.labels.manage', 'compliance.register.view', 'compliance.register.manage', 'imports.view', 'imports.run', 'imports.apply', 'inventory.locations.view', 'inventory.stock.view', 'inventory.transfer', 'inventory.scrap', 'inventory.opening.import', 'parties.view', 'production.serials', 'workorders.view', 'quality.lots.view', 'quality.lots.test', 'quality.lots.documents', 'quality.lots.release', 'quality.lots.reject', 'quality.inspections.view', 'quality.inspections.record', 'quality.garments.release', 'quality.garments.reverse', 'home.view', 'production.rework', 'production.scrap.view',
      // B-W2a-26: keeps the defect library and disposition codes; places and releases holds (only quality releases).
      'quality.defects.view', 'quality.defects.manage', 'quality.holds.view', 'quality.holds.place', 'quality.holds.release',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export'],
    grains: [],
  }),
  template('floor_supervisor', {
    name: 'Floor supervisor',
    description: "Follows the lines of their sites from the Office, decides the floor's scan corrections and keeps their floor devices, workers, badges and PINs; sees no money.",
    requireMfa: false,
    permissions: ['files.read', 'devices.view', 'devices.manage', 'devices.revoke', 'workers.view', 'workers.manage', 'workers.roles', 'workers.credentials', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'product.materials.view', 'product.styles.view', 'product.routing.view', 'inventory.locations.view', 'inventory.stock.view', 'inventory.transfer', 'production.settings.view', 'production.scan.correct', 'workorders.view', 'floorsync.view', 'floorsync.discard', 'home.view', 'calendars.view', 'production.rework', 'production.scrap.view', 'production.cutting.view',
      // B-W2a-18: sees the floor's reason lists (Floor rules & codes).
      'reasons.view',
      // B-W2a-26 (MES-008): puts work orders and bundles on hold; reads the defect library.
      'quality.holds.view', 'quality.holds.place', 'quality.defects.view',
      // B-W2b-29: decides the floor's off-standard blocks (MES-157), as it decides scan corrections; never one's own.
      'production.offstandard.view', 'production.offstandard.approve',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export'],
    grains: [],
  }),
  // B-W2a-35 (the plant; Owner answer H1): the office's maintenance lead and technicians.
  template('maintenance', {
    name: 'Maintenance',
    description: 'Keeps the machines running: the machine register and its classes and symptoms, the requests from the stations and the maintenance jobs; signs a machine marked unsafe safe again; sees no money.',
    requireMfa: false,
    permissions: ['files.read', 'files.upload', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'print.documents', 'sites.view', 'workers.view', 'parties.view', 'home.view', 'calendars.view', 'tasks.manage', 'views.save', 'views.export', 'plant.view', 'plant.machines.manage', 'plant.report', 'plant.requests.triage', 'plant.jobs.manage', 'plant.jobs.work', 'plant.signSafe'],
    grains: [],
  }),
  template('read_only', {
    name: 'Read-only',
    description: 'Sees every screen its scope reaches and changes nothing; sees no money.',
    requireMfa: false,
    permissions: every((risk) => risk === 'read'),
    grains: [],
  }),
  floorTemplate('operator', {
    name: 'Operator',
    description: 'Works at a station on an enrolled floor device; sees no money.',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'inventory.receive', 'production.cut', 'production.bundles', 'production.scan', 'production.serials', 'shipping.pack', 'production.rework'],
    grains: [],
  }),
  floorTemplate('cutting_operator', {
    name: 'Cutting operator',
    description: 'Works at a cutting table on an enrolled floor device; sees no money.',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'production.cut', 'production.bundles', 'production.scan'],
    grains: [],
  }),
  floorTemplate('floor_inspector', {
    name: 'Floor inspector',
    description: 'Inspects work at an inspection bench on an enrolled floor device, and signs and releases the final inspection there with the PIN; sees no money.',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'production.scan', 'quality.inspections.view', 'quality.inspections.record', 'quality.garments.release', 'production.rework'],
    grains: [],
  }),
  floorTemplate('team_leader', {
    name: 'Team leader',
    description: "Leads a crew on the floor: works and sees the team leader's screens of the device's site; sees no money.",
    permissions: ['floor.work', 'floor.lead', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'inventory.receive', 'production.cut', 'production.bundles', 'production.scan', 'production.serials', 'quality.inspections.view', 'shipping.pack', 'production.rework'],
    grains: [],
  }),
  // B-W2a-35 (the plant; Owner answer H1): the technician on the floor (maintenance mode).
  floorTemplate('technician', {
    name: 'Maintenance technician',
    description: 'Works maintenance jobs on an enrolled floor device: starts them, waits for parts, hands the machine back, and signs a machine marked unsafe safe again with the PIN; sees no money.',
    permissions: ['floor.work', 'print.view', 'print.labels', 'plant.report', 'plant.jobs.work', 'plant.signSafe'],
    grains: [],
  }),
])

const byKey = new Map(ROLE_TEMPLATES.map((entry) => [entry.key, entry]))

export function templateOf(key: string): RoleTemplate | undefined {
  return byKey.get(key)
}

/** The templates' own consistency (run at load: a template naming an unknown permission stops the import). */
export function templateProblems(templates: readonly RoleTemplate[]): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const entry of templates) {
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(entry.key)) problems.push(`${entry.key}: a template key is lower snake case`)
    if (keys.has(entry.key)) problems.push(`${entry.key}: declared twice`)
    keys.add(entry.key)
    for (const permission of entry.permissions) {
      const definition = FACTORY_PERMISSIONS.get(permission)
      if (!definition) problems.push(`${entry.key}: ${permission} is not declared`)
      else if (definition.grain !== undefined) problems.push(`${entry.key}: ${permission} is a grain; list it in grains`)
    }
    for (const grain of entry.grains) if (!isGrain(grain)) problems.push(`${entry.key}: ${String(grain)} is not a grain`)
    problems.push(...audienceProblems(entry).map((problem) => `${entry.key}: ${problem}`))
    const sees = entry.grains.filter((grain) => grain === 'cost' || grain === 'margin')
    if (sees.length > 0 && !entry.requireMfa) problems.push(`${entry.key}: a role that sees ${sees.join(' and ')} requires two-factor`)
  }
  if (!keys.has('owner')) problems.push('the owner template is missing')
  return problems
}

/**
 * What a role's audience forbids in its content: a floor role holds only `floor.*` permissions (and the few shared with
 * the floor), at most the wages grain and no two-factor rule; an office role holds no `floor.*` permission.
 */
export function audienceProblems(role: { readonly audience: RoleAudience } & Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>): string[] {
  const floorPermission = (permission: string) => FACTORY_PERMISSIONS.get(permission)?.area === FLOOR_AREA
  const sharedWithFloor = (permission: string) => (FLOOR_SHARED_PERMISSIONS as readonly string[]).includes(permission)
  if (role.audience === 'floor') {
    const problems: string[] = []
    for (const permission of role.permissions) {
      if (!floorPermission(permission) && !sharedWithFloor(permission)) problems.push(`a floor role holds only floor permissions, not ${permission}`)
    }
    for (const grain of role.grains) if (grain !== 'wages') problems.push(`a floor role sees at most wages, not ${grain}`)
    if (role.requireMfa) problems.push('a floor role cannot require two-factor')
    return problems
  }
  return role.permissions.filter(floorPermission).map((permission) => `${permission} is held only by floor roles`)
}

const problems = templateProblems(ROLE_TEMPLATES)
if (problems.length > 0) throw new Error(`Role templates are not valid: ${problems.join('; ')}`)
