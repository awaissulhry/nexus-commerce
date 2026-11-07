import type { Permission } from '../../core/permissions'
import { GRAINS, isGrain, type Grain } from '../grains/grains'
import { FACTORY_PERMISSIONS, FLOOR_AREA, FLOOR_SHARED_PERMISSIONS } from '../permissions/catalogue'
// B-W2b-162: the partner role templates (audience partner).
import { partnerRoleTemplates, partnerTemplateProblems, type PartnerRoleTemplate } from './partner-templates'

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
  // B-W2b-96: plant.settings.manage (a site's request routing and unsafe-lock settings) for the production manager.
  // B-W2b-124: plant.checks.manage (the statutory periodic checks: types, plans, the register) for the production manager.
  production_manager: ['plant.view', 'plant.machines.manage', 'plant.report', 'plant.requests.triage', 'plant.jobs.manage', 'plant.settings.manage', 'plant.checks.manage'],
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
/**
 * B-W2b-41 (bundles tracked; MES-074, MES-075, MES-168; design production.bundles): who sees where every bundle is, the
 * stuck ones and the scan-pattern checks as counts (production.bundles.view), and who reviews a finding
 * (production.bundles.findings: the production manager). Office only. No template opens the names behind a finding
 * (production.bundles.who): the owner through every(), or a custom role the owner makes (Statuto art. 4).
 */
const BUNDLES_TRACKED_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['production.bundles.view', 'production.bundles.findings'],
  floor_supervisor: ['production.bundles.view'],
  planner: ['production.bundles.view'],
  quality_inspector: ['production.bundles.view'],
})
/**
 * B-W2b-27 (privacy of people data; PLT-209, ANA-075, MES-249; design people.settings "Privacy of people data", admin.privacy
 * "People data rules"): the administrator (who keeps the privacy pack) and the production manager read the legal gate of
 * each site and purpose and the privacy settings. Switching a purpose on or off (people.privacy.manage) and opening one
 * person's figures (people.figures.view) are in no template: the Owner holds them through every office permission and
 * records the basis per site and purpose (GATE-LABOUR); an HR role gets people.figures.view (Owner answer H3).
 */
const PEOPLE_PRIVACY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.privacy.view'],
  production_manager: ['people.privacy.view'],
})
/**
 * B-W2b-35 (help calls, MES-142 … MES-145, MES-147, MES-137; design production.calls, floor.supervisor, floor.help): the
 * office reads the calls and answers them where its people respond (production, the floor supervisor, maintenance, the
 * warehouse for material, quality); the production manager keeps the types and who answers them (Floor rules & codes).
 * On the floor the team leader (the line view), the technician and the floor inspector read their line's calls and
 * answer them; every floor role SENDS a call with floor.work and needs nothing here. Owner and read-only from every().
 */
const CALLS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['production.calls.view', 'production.calls.answer', 'production.calls.manage'],
  floor_supervisor: ['production.calls.view', 'production.calls.answer'],
  maintenance: ['production.calls.view', 'production.calls.answer'],
  warehouse: ['production.calls.view', 'production.calls.answer'],
  quality_inspector: ['production.calls.view', 'production.calls.answer'],
})
const CALLS_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: ['production.calls.view', 'production.calls.answer'],
  technician: ['production.calls.view', 'production.calls.answer'],
  floor_inspector: ['production.calls.view', 'production.calls.answer'],
})
/**
 * B-W2b-46 (checks before a scan counts, MES-070, MES-097, MES-098; design floor.operation "Team leader override"): the
 * team leader overrides a held scan on the tablet with their own PIN and a reason. Floor only. The owner from every().
 */
const GUARDS_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: ['production.scan.override'],
})
/**
 * B-W2b-47 (more on the tablet, MES-099, MES-086; design floor.supervisor "Scan on behalf"): the team leader records work
 * for someone who could not scan and adds an unplanned operation on the tablet; the production office adds one to a work
 * order too. The owner from every().
 */
const TABLET_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: ['production.scan.behalf', 'production.extraops.add'],
})
const TABLET_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['production.extraops.add'],
  floor_supervisor: ['production.extraops.add'],
})
/**
 * B-W2b-37 (attendance days; MES-225, MES-226, MES-228, MES-233, MES-238; design people.attendance, people.settings): the
 * administrator (the HR register's keeper until an HR template comes) and the production manager read the days, fix them
 * with a reason, approve them and open the roll call; the administrator keeps the absence codes and the rounding rules;
 * the floor supervisor opens the roll call and sees who is in now (counts), never one person's day: the ATTENDANCE gate's
 * basis never covers leads (B-W2b-27). Owner and read-only take theirs from every(). One line per template.
 */
const PEOPLE_ATTENDANCE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.attendance.view', 'people.attendance.manage', 'people.attendance.approve', 'people.attendance.settings', 'people.attendance.rollcall'],
  production_manager: ['people.attendance.view', 'people.attendance.manage', 'people.attendance.approve', 'people.attendance.rollcall'],
  floor_supervisor: ['people.attendance.rollcall'],
})
/**
 * B-W2b-44 (efficiency; MES-247, MES-250, MES-251, ANA-016, ANA-017; design people.efficiency "What you see here": owner,
 * supervisor, the industrial engineer): the production manager and the floor supervisor read the figures per line and per
 * operation; the production manager decides the standard review. Nobody here sees one person's figures: that is
 * people.figures.view (B-W2b-27), held by no template. Owner and read-only take theirs from every(). One line per template.
 */
const PEOPLE_EFFICIENCY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['people.efficiency.view', 'people.efficiency.review'],
  floor_supervisor: ['people.efficiency.view'],
})
/**
 * B-W2b-42 (overtime worked, timesheets, working-time limits; MES-229, MES-230, MES-232): the administrator (the HR
 * register's keeper) decides overtime, gives HR's approval of a timesheet and keeps the limits; the production manager
 * decides overtime and stands in as the lead for any timesheet; the floor supervisor approves as the lead the timesheets of
 * the teams they lead (the days, not the hours). Owner from every(). One line per template.
 */
const PEOPLE_OVERTIME_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.overtime.review', 'people.timesheets.hr', 'people.limits.manage'],
  production_manager: ['people.overtime.review', 'people.timesheets.lead'],
  floor_supervisor: ['people.timesheets.team'],
})
/**
 * B-W2b-48 (the month close and the LUL calendar; MES-231): the administrator, the HR register's keeper, closes the month,
 * corrects a closed day and opens the calendar for the labour consultant. Nobody else: the calendar names everyone's hours.
 * Owner from every(). One line per template.
 */
const PEOPLE_CLOSE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.attendance.close', 'people.attendance.correct', 'people.attendance.lul'],
})
/**
 * B-W2b-50 (line targets and boards, MES-084, MES-161, MES-162, MES-166, ANA-007; design production.floor "Hour by hour",
 * the WIP heat map, the line TV's office preview): the production manager, the floor supervisor and the planner set the
 * lines' hourly targets; the manager and the supervisor give a short hour's reason from the office too; quality reads the
 * boards (DHU). On the floor the team leader's line view reads its line's hour by hour and gives the reason. A line TV
 * (DISPLAY device) needs no role: nobody signs in on it. Owner and read-only from every().
 */
const BOARDS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['production.boards.view', 'production.boards.targets', 'production.boards.reason'],
  floor_supervisor: ['production.boards.view', 'production.boards.targets', 'production.boards.reason'],
  planner: ['production.boards.view', 'production.boards.targets'],
  quality_inspector: ['production.boards.view'],
})
const BOARDS_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: ['production.boards.view', 'production.boards.reason'],
})
/**
 * B-W2b-49 (dispatch every shift, MES-022 … MES-033; design production.dispatch, floor.supervisor): the production manager
 * and the floor supervisor run the board and write handover notes; the planner reads it. On the floor the team leader's
 * line view reads its line, reassigns work and writes the handover note. Owner and read-only from every().
 */
const DISPATCH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['production.dispatch.view', 'production.dispatch.manage', 'production.dispatch.handover'],
  floor_supervisor: ['production.dispatch.view', 'production.dispatch.manage', 'production.dispatch.handover'],
  planner: ['production.dispatch.view'],
})
const DISPATCH_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: ['production.dispatch.view', 'production.dispatch.manage', 'production.dispatch.handover'],
})
/**
 * B-W2b-34 (piece rates and the legal switch of piece pay; MES-254, MES-255, MES-262; design people.piecerates): the
 * administrator and the production manager read the rate tables, who has read them and the legal switch, without a pay
 * figure (neither holds the pay grain: operations and standard minutes only). Keeping the rates (people.piecerates.manage:
 * typing a rate needs the pay grain) and starting piece pay (people.piecerates.switch, GATE-PIECE-PAY) are in no template:
 * the Owner holds them through every office permission; an HR role gets them with the pay grain.
 */
const PEOPLE_PIECERATES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.piecerates.view'],
  production_manager: ['people.piecerates.view'],
})
/**
 * B-W2b-43 (earnings and pay periods): the administrator, production manager and floor supervisor see the periods, their
 * states and the held scans with no name (no pay figure: they hold no pay grain); a lead reviews a statement's pieces and
 * minutes where the site's legal basis lets them. One person's pay (people.earnings.records) and running a period
 * (people.earnings.manage) are in no template: the Owner holds them through every office permission; an HR role gets them
 * with the pay grain.
 */
const PEOPLE_EARNINGS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.earnings.view'],
  production_manager: ['people.earnings.view', 'people.earnings.review'],
  floor_supervisor: ['people.earnings.view', 'people.earnings.review'],
})
/**
 * B-W2b-54 (the payroll export, MES-267 to MES-274; design people.payroll): the administrator keeps the mapping and makes the
 * hours file, as it closes the month and opens the LUL calendar. Amounts ask the pay grain, so with piece pay in the month
 * only the Owner or HR (a custom role with the grain) makes the file. Owner from every(); read-only reads the view.
 */
const PEOPLE_PAYROLL_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.payroll.view', 'people.payroll.records', 'people.payroll.manage'],
})
/**
 * B-W2b-94 (hides as stock; SCM-249, SCM-250; design warehouse.hides record "Measurements & grade"): the warehouse, which keeps
 * the hides, and the quality inspector, who grades them, correct a hide's grade, shade group, thickness and defects and measure
 * a whole hide again against the tannery's area (correcting its stock is inventory.adjust: the warehouse's). Office only; Owner
 * from every(). One line per template.
 */
const HIDES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: ['inventory.hides.manage'],
  quality_inspector: ['inventory.hides.manage'],
})

/**
 * B-W2b-100 (one shade lot per order; SCM-206): the production manager and the quality inspector let a hide of another shade
 * lot into an order that asks one (with the reason). The warehouse picks and reserves, and is refused in words. Office only;
 * Owner from every(). One line per template.
 */
const SHADE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['inventory.shade.override'],
  quality_inspector: ['inventory.shade.override'],
})
/**
 * B-W2b-103 (leather cutting rules; MES-053, MES-063, MES-064; design floor.hidecut pop-up "Cut anyway?"): the team leader lets a
 * hide be cut anyway when the table's checks warn, signed on the cutter's tablet with their own PIN and a reason. Floor only;
 * Owner from every().
 */
const CUT_OVERRIDE_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: ['production.cut.override'],
})
/**
 * B-W2b-92 (inspection plans, QHS-008, QHS-009, QHS-016; design quality.plans): quality keeps the plans and approves another
 * person's draft (never one it wrote); the production manager reads them and may be the second person who approves (a small
 * factory has one quality person); the floor supervisor reads them and prints a checklist for a bench without a tablet.
 * Office only (a bench reads the version its record runs on through GET /quality/plan-versions/:id). Owner and read-only
 * from every().
 */
const QUALITY_PLANS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.plans.view', 'quality.plans.manage', 'quality.plans.approve'],
  production_manager: ['quality.plans.view', 'quality.plans.approve'],
  floor_supervisor: ['quality.plans.view'],
})
/**
 * B-W2b-93 (AQL profiles and the AQL calculator, QHS-020, QHS-021; design quality.plans pl-aql, pl-calc): quality keeps
 * the companies' AQL profiles and assigns them to customers and styles; the production manager and sales read which
 * profile a customer or a style has (sales.customers "customer AQL profiles"). Office only; the owner and read-only take
 * theirs from every(). Applying a profile to an inspection is quality.inspections.record (B-W1-45), unchanged.
 */
const AQL_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.aql.view', 'quality.aql.manage'],
  production_manager: ['quality.aql.view'],
  sales: ['quality.aql.view'],
})
/**
 * B-W2b-101 (inspection triggers, QHS-010, QHS-011; design quality.plans "When inspections are created"): quality keeps the
 * rules that open inspections by themselves; the production manager and the floor supervisor read them (a first-piece rule
 * holds a run until its check is approved). Office only: the worker's handler applies them. Owner and read-only from every().
 */
const QUALITY_TRIGGERS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.triggers.view', 'quality.triggers.manage'],
  production_manager: ['quality.triggers.view'],
  floor_supervisor: ['quality.triggers.view'],
})
/**
 * B-W2b-98 (incoming inspection hide by hide, QHS-025, QHS-028, QHS-034, MES-054; design floor.incoming, quality.inspections
 * "Incoming"): quality inspects a lot and signs the decision, in the office or on the inspection tablet at the dock (the
 * floor inspector, with the PIN); the warehouse that received the lot, the buyer who claims its shortfall or returns its
 * rejected hides and the production manager read it. Releasing the lot stays quality.lots.release (Owner answer W3). Owner
 * and read-only from every().
 */
const INCOMING_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.incoming.view', 'quality.incoming.record'],
  warehouse: ['quality.incoming.view'],
  buyer: ['quality.incoming.view'],
  production_manager: ['quality.incoming.view'],
})
const INCOMING_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  floor_inspector: ['quality.incoming.view', 'quality.incoming.record'],
})
/**
 * B-W2b-99 (in-process checks, QHS-039 … QHS-042, MES-127; design floor.inline modes inspection and supervisor): the
 * quality inspector, the production manager and the floor supervisor open, record and sign checks in the office; on the
 * floor the floor inspector and the team leader do at their own site. Owner and read-only from every().
 */
const INPROCESS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.inprocess.view', 'quality.inprocess.record'],
  production_manager: ['quality.inprocess.view', 'quality.inprocess.record'],
  floor_supervisor: ['quality.inprocess.view', 'quality.inprocess.record'],
})
const INPROCESS_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  floor_inspector: ['quality.inprocess.view', 'quality.inprocess.record'],
  team_leader: ['quality.inprocess.view', 'quality.inprocess.record'],
})
/**
 * B-W2b-107 (rolls, protector lots and consumables; SCM-260, SCM-261; design warehouse.lots, floor.operation "Trace
 * protectors and lots per garment"): the warehouse, which keeps the rolls, and the quality inspector, who measures their
 * width and shrinkage and sorts their shade, correct what a roll is; tagging, issuing, moving, scrapping and correcting a roll
 * stay the ledger's permissions those roles already hold. Production (the manager and the floor supervisor) and quality
 * record which protector lot a batch or a garment holds, and the operators and team leaders do it on the line's tablet;
 * only the office withdraws a wrong record. Owner from every().
 */
const ROLLS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: ['inventory.rolls.manage'],
  quality_inspector: ['inventory.rolls.manage', 'inventory.protectors.record'],
  production_manager: ['inventory.protectors.record'],
  floor_supervisor: ['inventory.protectors.record'],
})
const ROLLS_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  operator: ['inventory.protectors.record'],
  team_leader: ['inventory.protectors.record'],
})
/**
 * B-W2b-108 (corrective actions, CAPA and 8D; QHS-087, QHS-093, QHS-094, QHS-096; design quality.capa): quality opens
 * CAPAs and 8Ds (also by escalating NCRs and complaints), follows their actions and keeps the 8D report; the production
 * manager does too (most corrective actions are on the floor's work); the floor supervisor, the buyer (a supplier's
 * cause) and sales (the customer's 8D) read them, and each records the actions they own done with view alone. Office
 * only; owner and read-only from every().
 */
const CAPA_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.capa.view', 'quality.capa.manage'],
  production_manager: ['quality.capa.view', 'quality.capa.manage'],
  floor_supervisor: ['quality.capa.view'],
  buyer: ['quality.capa.view'],
  sales: ['quality.capa.view'],
})
/**
 * B-W2b-123 (locked results with amendments, QHS-145; the inspection report and the certificate of conformity, QHS-055,
 * QHS-059; design ins-amend "second signature (another inspector or the quality manager)"): the quality inspector asks for
 * corrections and countersigns another person's (never their own), keeps the report and the certificate and puts them on a
 * shipment's documents link; to find the shipment that carries the goods it released and certify it, it reads shipments
 * (shipping.view; no money: the carrier's cost is the cost grain it does not hold). The warehouse mails that link as before
 * (shipping.manage). Office only; owner from every().
 */
const AMENDMENTS_DOCUMENTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.amendments.request', 'quality.amendments.sign', 'quality.documents.make', 'quality.documents.share', 'shipping.view'],
})
/**
 * B-W2b-120 (the safety organisation and the safety calendar; QHS-224, QHS-226, QHS-227; design plant.calendar): the
 * production manager, the maintenance lead (statutory machine checks are on the calendar) and the floor supervisor (the
 * preposti) read the calendar and the organisation; the safety roles keep them in their own templates below (hr,
 * safety_officer, company_doctor). Office only; owner and read-only from every().
 */
const SAFETY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['safety.view'],
  maintenance: ['safety.view'],
  floor_supervisor: ['safety.view'],
})
/**
 * B-W2b-118 (quality rules; QHS-154, QHS-300; design quality.settings SCR-260): quality reads the rules page and keeps the
 * alert and escalation rules (the quality manager of the design is the quality inspector's role); the production manager
 * and the floor supervisor read it (the rules quote back where a button waits). Changing who may sign what and the result
 * rules stays quality.settings.manage (the owner's, B-W1-34). Office only; owner and read-only from every().
 */
const QUALITY_RULES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.rules.view', 'quality.alerts.manage'],
  production_manager: ['quality.rules.view'],
  floor_supervisor: ['quality.rules.view'],
})
/**
 * B-W2b-126 (the repair station and second quality, MES-132, MES-133; design floor.mywork "repair queue", production.scrap
 * "Downgrade to second quality"): the production manager and the quality inspector send scrapped garments to second quality
 * in the office (a stock decision: it puts them into a place); on the floor the operators and team leaders see the repair
 * queue and scan bundles in and out at a repair station of their site. Owner from every().
 */
const REWORK_REPAIR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['production.downgrade'],
  quality_inspector: ['production.downgrade'],
})
const REWORK_REPAIR_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  operator: ['production.repair'],
  team_leader: ['production.repair'],
})
/**
 * B-W2b-122 (the risk assessment, the DVR; QHS-230, QHS-234; design plant.risk): the safety officer keeps the assessments,
 * freezes the consultant's versions, records signed papers and keeps the improvement plan (no money: a measure's cost is the
 * cost grain it does not hold), and signs for the role it holds (an in-house RSPP); the occupational doctor signs a version
 * for its own role. A measure's owner moves their own measure with safety.view. Office only; owner from every().
 */
const RISK_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  safety_officer: ['safety.risk.manage', 'safety.risk.sign'],
  company_doctor: ['safety.risk.sign'],
})
/**
 * B-W2b-125 (incidents, near misses and hazards; QHS-265, QHS-268, QHS-270; design plant.incidents): the production manager,
 * the maintenance lead and the floor supervisor (the preposti) see the incidents anonymised and report from the office; the
 * safety officer keeps them (severity, seen, actions, close) and, with HR, sees the people involved and keeps the INAIL
 * filings (protected: each view recorded). The occupational doctor holds none (fitness judgements only). A tablet reports
 * with floor.work: no floor template changes. Office only; owner from every(); read-only gets the view only (the people
 * permission is a write risk on purpose).
 */
const INCIDENTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: ['safety.incidents.view', 'safety.incidents.report'],
  maintenance: ['safety.incidents.view', 'safety.incidents.report'],
  floor_supervisor: ['safety.incidents.view', 'safety.incidents.report'],
  safety_officer: ['safety.incidents.view', 'safety.incidents.report', 'safety.incidents.manage', 'safety.incidents.people'],
  hr: ['safety.incidents.view', 'safety.incidents.report', 'safety.incidents.people'],
})
/**
 * B-W2b-138 (quality reports, QHS-147 "Quality KPIs, with reports per role"; design quality.reports SCR-147): quality, the
 * production manager and the floor supervisor read the quality reports of their sites; the buyer reads them for incoming
 * quality per supplier. Each figure also needs the view permission of its records, which each role already holds or not
 * (reports per role). Office only; owner and read-only from every().
 */
const QUALITY_REPORTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: ['quality.reports.view'],
  production_manager: ['quality.reports.view'],
  floor_supervisor: ['quality.reports.view'],
  buyer: ['quality.reports.view'],
})
/**
 * B-W2b-128 (role risk sheets, QHS-236; design plant.risk "Role sheets"; Owner answer H2): the safety officer types the 6 to
 * 10 role sheets (risks, PPE kit, courses, whether the role needs health surveillance) and applies them. Which sheet a person
 * is in stays the HR record's (people.employees.manage). Office only; owner from every(); read_only gets none (no read added).
 */
const ROLESHEETS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  safety_officer: ['safety.rolesheets.manage'],
})
// B-W2b-132: the leather and cut plan — the planner (the design's role) changes a style's cutting loss from its cuts (into the
// draft revision) or dismisses the proposal with a reason. The owner from every().
const LEATHER_PLAN_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: ['planning.leather.manage'],
})
/**
 * B-W2b-133 (the course catalogue and who needs which course, QHS-241, QHS-242; design people.skills "Course catalogue", "Who
 * needs what"): the safety officer keeps the catalogue (hours and refresher periods typed from the company's programme) and
 * the courses a type of machine asks. A role's courses stay the role sheet's. Office only; owner from every(); read_only gets
 * none (no read added: reading is safety.view).
 */
const TRAINING_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  safety_officer: ['safety.training.manage'],
})
/**
 * B-W2b-134 (PPE for workers, QHS-259, QHS-260, QHS-261; design plant.ppe): the safety officer keeps the PPE catalogue and, with
 * HR, records paper receipts and voids wrong issues; the floor supervisor (the preposto who hands PPE out on the floor) records
 * paper receipts too. Reading is safety.view; on the floor the person receiving signs with badge and PIN under floor.work (no
 * floor template changes). Office only; owner from every(); read_only gets none (both are writes).
 */
const PPE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  safety_officer: ['safety.ppe.manage', 'safety.ppe.issue'],
  hr: ['safety.ppe.issue'],
  floor_supervisor: ['safety.ppe.issue'],
})
/**
 * B-W2b-143 (the chemical register and the safety data sheets; QHS-277, QHS-278; design plant.chemicals): the safety officer
 * keeps the register and replaces the data sheets; every role with safety.view reads them (no person, no money), and a
 * tablet of the site reads its own site's with floor.work (the cabinet QR). Office only; owner from every().
 */
const CHEMICALS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  safety_officer: ['safety.chemicals.manage'],
})
// B-W2b-135: health surveillance (GDPR art. 9; D.Lgs. 81/2008 art. 41) — HR and the occupational doctor see the due list and the
// judgements (each view recorded) and keep them; the safety officer and the doctor keep the plans per role (no person in a plan);
// HR reads who looked. Office only; owner from every(); read-only none (every one is a write risk on purpose).
const HEALTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  hr: ['safety.health.view', 'safety.health.manage', 'safety.health.views'],
  company_doctor: ['safety.health.view', 'safety.health.manage', 'safety.health.plans'],
  safety_officer: ['safety.health.plans'],
})
/**
 * B-W2b-139 (training records, due lists, the instruction register, attendance signed on the floor; QHS-243, QHS-244, QHS-246,
 * QHS-247, QHS-248; design people.skills "Record training", "Instruction register"): the safety officer and HR keep the
 * training records (sessions, paper sheets, countersignatures in the office, records typed, corrections); the instruction
 * register also by the production manager and the floor supervisor (the preposti give hands-on instruction). The workers and
 * the trainer sign on the floor with floor.work: no floor template changes. Office only; owner from every(); read_only gets
 * none (writes; reading is safety.view).
 */
const RECORDS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  safety_officer: ['safety.training.record', 'safety.instruction.record'],
  hr: ['safety.training.record', 'safety.instruction.record'],
  production_manager: ['safety.instruction.record'],
  floor_supervisor: ['safety.instruction.record'],
})
/**
 * B-W2b-162 (partner organisations, their people and roles; PLT-006, SAL-060, SCM-092; design sales.customers and
 * purchasing.suppliers › Portal access, admin.users): sales looks after its customers' portal access and the buyer its
 * suppliers' and workshops' (invite, change, switch on, preview); the administrator all of them. The owner from every();
 * read-only sees who has access (partners.view) through the registry.
 */
const PARTNERS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['partners.view', 'partners.invite', 'partners.manage', 'partners.preview'],
  sales: ['partners.view', 'partners.invite', 'partners.manage', 'partners.preview'],
  buyer: ['partners.view', 'partners.invite', 'partners.manage', 'partners.preview'],
})
/**
 * B-W2b-167 (tasks for partners, COL-043; design office home.tasks "tasks staff give the customer"): who looks after a
 * partner's portal also asks it for documents, answers, measurements and progress, and moves or withdraws those requests.
 */
const PARTNER_TASKS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['partners.tasks.manage'],
  sales: ['partners.tasks.manage'],
  buyer: ['partners.tasks.manage'],
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
  ...(audience === 'office' ? (PAYABLES_SETTINGS_ADDS[key] ?? []) : []),
  // B-W2b-41
  ...(audience === 'office' ? (BUNDLES_TRACKED_ADDS[key] ?? []) : []),
  // B-W2b-27
  ...(audience === 'office' ? (PEOPLE_PRIVACY_ADDS[key] ?? []) : []),
  // B-W2b-35
  ...((audience === 'office' ? CALLS_ADDS : CALLS_FLOOR_ADDS)[key] ?? []),
  // B-W2b-46
  ...(audience === 'floor' ? (GUARDS_FLOOR_ADDS[key] ?? []) : []),
  // B-W2b-47
  ...((audience === 'office' ? TABLET_ADDS : TABLET_FLOOR_ADDS)[key] ?? []),
  // B-W2b-50
  ...((audience === 'office' ? BOARDS_ADDS : BOARDS_FLOOR_ADDS)[key] ?? []),
  // B-W2b-34
  ...(audience === 'office' ? (PEOPLE_PIECERATES_ADDS[key] ?? []) : []),
  // B-W2b-37
  ...(audience === 'office' ? (PEOPLE_ATTENDANCE_ADDS[key] ?? []) : []),
  // B-W2b-44
  ...(audience === 'office' ? (PEOPLE_EFFICIENCY_ADDS[key] ?? []) : []),
  // B-W2b-42
  ...(audience === 'office' ? (PEOPLE_OVERTIME_ADDS[key] ?? []) : []),
  // B-W2b-48
  ...(audience === 'office' ? (PEOPLE_CLOSE_ADDS[key] ?? []) : []),
  // B-W2b-43
  ...(audience === 'office' ? (PEOPLE_EARNINGS_ADDS[key] ?? []) : []),
  // B-W2b-54
  ...(audience === 'office' ? (PEOPLE_PAYROLL_ADDS[key] ?? []) : []),
  // B-W2b-94
  ...(audience === 'office' ? (HIDES_ADDS[key] ?? []) : []),
  // B-W2b-100
  ...(audience === 'office' ? (SHADE_ADDS[key] ?? []) : []),
  // B-W2b-103
  ...(audience === 'floor' ? (CUT_OVERRIDE_FLOOR_ADDS[key] ?? []) : []),
  // B-W2b-92
  ...(audience === 'office' ? (QUALITY_PLANS_ADDS[key] ?? []) : []),
  // B-W2b-49
  ...((audience === 'office' ? DISPATCH_ADDS : DISPATCH_FLOOR_ADDS)[key] ?? []),
  // B-W2b-93
  ...(audience === 'office' ? (AQL_ADDS[key] ?? []) : []),
  // B-W2b-101
  ...(audience === 'office' ? (QUALITY_TRIGGERS_ADDS[key] ?? []) : []),
  // B-W2b-98
  ...((audience === 'office' ? INCOMING_ADDS : INCOMING_FLOOR_ADDS)[key] ?? []),
  // B-W2b-99
  ...((audience === 'office' ? INPROCESS_ADDS : INPROCESS_FLOOR_ADDS)[key] ?? []),
  // B-W2b-107
  ...((audience === 'office' ? ROLLS_ADDS : ROLLS_FLOOR_ADDS)[key] ?? []),
  // B-W2b-108
  ...(audience === 'office' ? (CAPA_ADDS[key] ?? []) : []),
  // B-W2b-123
  ...(audience === 'office' ? (AMENDMENTS_DOCUMENTS_ADDS[key] ?? []) : []),
  // B-W2b-120
  ...(audience === 'office' ? (SAFETY_ADDS[key] ?? []) : []),
  // B-W2b-118
  ...(audience === 'office' ? (QUALITY_RULES_ADDS[key] ?? []) : []),
  // B-W2b-126
  ...((audience === 'office' ? REWORK_REPAIR_ADDS : REWORK_REPAIR_FLOOR_ADDS)[key] ?? []),
  // B-W2b-122
  ...(audience === 'office' ? (RISK_ADDS[key] ?? []) : []),
  // B-W2b-125
  ...(audience === 'office' ? (INCIDENTS_ADDS[key] ?? []) : []),
  // B-W2b-138
  ...(audience === 'office' ? (QUALITY_REPORTS_ADDS[key] ?? []) : []),
  // B-W2b-128
  ...(audience === 'office' ? (ROLESHEETS_ADDS[key] ?? []) : []),
  // B-W2b-132
  ...(audience === 'office' ? (LEATHER_PLAN_ADDS[key] ?? []) : []),
  // B-W2b-133
  ...(audience === 'office' ? (TRAINING_ADDS[key] ?? []) : []),
  // B-W2b-134
  ...(audience === 'office' ? (PPE_ADDS[key] ?? []) : []),
  // B-W2b-143
  ...(audience === 'office' ? (CHEMICALS_ADDS[key] ?? []) : []),
  // B-W2b-135
  ...(audience === 'office' ? (HEALTH_ADDS[key] ?? []) : []),
  // B-W2b-139
  ...(audience === 'office' ? (RECORDS_ADDS[key] ?? []) : []),
  // B-W2b-162
  ...(audience === 'office' ? (PARTNERS_ADDS[key] ?? []) : []),
  // B-W2b-167
  ...(audience === 'office' ? (PARTNER_TASKS_ADDS[key] ?? []) : [])]
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

/**
 * B-W2b-26 (people: employees, teams and loans, leaver steps; MES-208 … MES-214, PLT-020; design people.employees, the
 * People area of the HR and payroll office): the administrator keeps the HR register (there is no HR template yet; when
 * one comes, these move to it); the production manager reads it, keeps the teams and their leads and lends people to
 * another line; the floor supervisor reads it and lends people at their sites. My team (people.team.view: the teams you
 * lead or belong to) for the office templates whose people lead or work in a crew (PEOPLE_TEAM_TEMPLATES). Office only:
 * the floor reads its crews with its own routes. Owner and read-only take theirs from every().
 */
const PEOPLE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.view', 'people.employees.manage', 'people.teams.manage', 'people.loans.manage', 'people.leavers.manage'],
  production_manager: ['people.view', 'people.teams.manage', 'people.loans.manage'],
  floor_supervisor: ['people.view', 'people.loans.manage'],
})
const PEOPLE_TEAM_TEMPLATES: ReadonlySet<string> = new Set(['production_manager', 'floor_supervisor', 'quality_inspector', 'warehouse', 'maintenance'])
const peopleAddedFor = (key: string, audience: RoleAudience): readonly Permission[] =>
  audience === 'office' ? [...(PEOPLE_ADDS[key] ?? []), ...(PEOPLE_TEAM_TEMPLATES.has(key) ? ['people.team.view' as Permission] : [])] : []
/**
 * B-W2b-32 (shifts and overtime requests; MES-218, MES-222; design people.shifts): the administrator (who keeps the HR
 * register until an HR template comes: move these with B-W2b-26's) and the production manager plan every roster of their
 * sites and ask and approve planned overtime; the floor supervisor reads the roster, plans the roster of the teams they
 * lead (design: "Leads edit their team; others read") and asks overtime, never approves it. Office only: a worker reads
 * their own published shifts and answers an ask on the tablet with floor.work. Owner and read-only from every().
 */
const PEOPLE_SHIFTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.shifts.view', 'people.shifts.manage', 'people.overtime.manage', 'people.overtime.approve'],
  production_manager: ['people.shifts.view', 'people.shifts.manage', 'people.overtime.manage', 'people.overtime.approve'],
  floor_supervisor: ['people.shifts.view', 'people.shifts.team', 'people.overtime.manage'],
})
const peopleShiftsAddedFor = (key: string, audience: RoleAudience): readonly Permission[] => (audience === 'office' ? (PEOPLE_SHIFTS_ADDS[key] ?? []) : [])

/**
 * B-W2b-39 (skills and machine authorisations; MES-241, MES-244, MES-246, MES-024; design people.skills): the
 * administrator (the HR register's keeper until an HR template comes), the production manager and the floor supervisor
 * (the leads: "1–4 set a level on a skill cell") read the matrix, set levels, give trainee periods, sign trainees off and
 * authorise people on machines. Office only: the floor reads its people's levels through the qualification check. Owner
 * and read-only take theirs from every(). One line per template.
 */
const SKILLS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: ['people.skills.view', 'people.skills.manage', 'people.authorisations.manage'],
  production_manager: ['people.skills.view', 'people.skills.manage', 'people.authorisations.manage'],
  floor_supervisor: ['people.skills.view', 'people.skills.manage', 'people.authorisations.manage'],
})
const skillsAddedFor = (key: string, audience: RoleAudience): readonly Permission[] => (audience === 'office' ? (SKILLS_ADDS[key] ?? []) : [])

/**
 * B-W2b-24 (PLT-125, design admin.documents popup `override`): type the number a migrated document had in the old system —
 * the administrator (who runs the go-live's first load) and finance (who keeps the number series). The owner and nobody
 * else through every(); never read_only, never a floor role. One line.
 */
const NUMBERING_OVERRIDE_TEMPLATES: ReadonlySet<string> = new Set(['admin', 'finance'])
const numberingOverrideAddedFor = (key: string, audience: RoleAudience): readonly Permission[] => (audience === 'office' && NUMBERING_OVERRIDE_TEMPLATES.has(key) ? ['numbering.override' as Permission] : [])

const template = (key: string, content: Omit<RoleTemplate, 'key' | 'audience'>, audience: RoleAudience = 'office'): RoleTemplate =>
  Object.freeze({ key, audience, ...content, permissions: Object.freeze([...new Set([...content.permissions, ...addedFor(key, audience), ...alertsAddedFor(key, audience), ...reportsAddedFor(key, audience), ...repairsAddedFor(key, audience), ...reportLibraryAddedFor(key, audience), ...numberingOverrideAddedFor(key, audience), ...peopleAddedFor(key, audience), ...peopleShiftsAddedFor(key, audience), ...skillsAddedFor(key, audience)])].sort()), grains: Object.freeze([...content.grains]) })
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
      // B-W2b-161: company branding (logo, accent, sender name, portal label; step-up).
      'documents.branding.manage',
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
      // B-W2b-53 (MES-128): approves or refuses scrap above a site's limit in the office.
      'production.scrap.overLimit',
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
      // B-W2b-45: Labour & corrections (MES-201 … MES-206): the queue, line days closed and reopened, disputes answered.
      'production.labour.view', 'production.labour.close', 'production.labour.reopen', 'production.labour.answer',
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
      // B-W2b-53 (MES-128): approves or refuses scrap above a site's limit from the Office.
      'production.scrap.overLimit',
      // B-W2b-29: decides the floor's off-standard blocks (MES-157), as it decides scan corrections; never one's own.
      'production.offstandard.view', 'production.offstandard.approve',
      // B-W2b-45: closes the lines' days and answers the workers' disputes as their lead (never their own); reopening is the manager's.
      'production.labour.view', 'production.labour.close', 'production.labour.answer',
      // B-W2a-23: save views of a list; export a list.
      'views.save', 'views.export'],
    grains: [],
  }),
  // B-W2a-35 (the plant; Owner answer H1): the office's maintenance lead and technicians.
  template('maintenance', {
    name: 'Maintenance',
    description: 'Keeps the machines running: the machine register and its classes and symptoms, the requests from the stations and the maintenance jobs; signs a machine marked unsafe safe again; sees no money.',
    requireMfa: false,
    permissions: ['files.read', 'files.upload', 'threads.read', 'threads.post', 'print.view', 'print.labels', 'print.documents', 'sites.view', 'workers.view', 'parties.view', 'home.view', 'calendars.view', 'tasks.manage', 'views.save', 'views.export', 'plant.view', 'plant.machines.manage', 'plant.report', 'plant.requests.triage', 'plant.jobs.manage', 'plant.jobs.work', 'plant.signSafe',
      // B-W2b-96: the site's request routing and unsafe-lock settings.
      'plant.settings.manage',
      // B-W2b-124: the statutory periodic checks (check types, plans, the check register with its reports).
      'plant.checks.manage'],
    grains: [],
  }),
  // B-W2b-120 (the hr template B-W2b-26 left open; W2b plan B-W2b-120): the HR office, the safety officer (RSPP) and the
  // occupational doctor. The administrator keeps its People permissions until the Owner moves them (a one-line change).
  template('hr', {
    name: 'HR',
    description: "The HR register and People: employees, teams and loans, leaver steps, shifts, attendance and the month close, skills, piece rates, earnings and the payroll file for the labour consultant; one person's figures where the site's legal basis allows (H3); the safety calendar and organisation (the teams' appointments); sees workers' pay, no prices or costs.",
    requireMfa: true,
    permissions: [
      'files.read', 'files.upload', 'threads.read', 'threads.post', 'documents.view', 'print.view', 'print.documents', 'home.view', 'calendars.view', 'tasks.manage', 'views.save', 'views.export', 'sites.view', 'workers.view',
      'people.view', 'people.team.view', 'people.employees.manage', 'people.teams.manage', 'people.loans.manage', 'people.leavers.manage',
      'people.shifts.view', 'people.shifts.manage', 'people.overtime.manage', 'people.overtime.approve', 'people.overtime.review', 'people.timesheets.hr', 'people.limits.manage',
      'people.skills.view', 'people.skills.manage', 'people.authorisations.manage',
      'people.attendance.view', 'people.attendance.manage', 'people.attendance.approve', 'people.attendance.settings', 'people.attendance.rollcall', 'people.attendance.close', 'people.attendance.correct', 'people.attendance.lul',
      'people.privacy.view', 'people.figures.view', 'people.piecerates.view', 'people.earnings.view', 'people.payroll.view', 'people.payroll.records', 'people.payroll.manage',
      'safety.view', 'safety.organisation.manage',
    ],
    grains: ['pay'],
  }),
  template('safety_officer', {
    name: 'Safety officer',
    description: "The safety officer (RSPP or ASPP): the safety organisation with its letters and the RLS notice to INAIL, the safety calendar and its deadlines, the machines and their statutory checks (read); sees no money.",
    requireMfa: false,
    permissions: ['files.read', 'files.upload', 'threads.read', 'threads.post', 'documents.view', 'print.view', 'print.documents', 'home.view', 'calendars.view', 'tasks.manage', 'views.save', 'views.export', 'sites.view', 'plant.view', 'safety.view', 'safety.organisation.manage', 'safety.calendar.manage'],
    grains: [],
  }),
  template('company_doctor', {
    name: 'Occupational doctor',
    description: 'The occupational doctor (medico competente): the safety calendar and organisation; fitness judgements come with the health pages, never a diagnosis or a clinical record; sees no money.',
    requireMfa: true,
    permissions: ['files.read', 'home.view', 'calendars.view', 'safety.view'],
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
    description: 'Works at a station on an enrolled floor device; sees only their own pay (the piece rates published to them).',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'inventory.receive', 'production.cut', 'production.bundles', 'production.scan', 'production.serials', 'shipping.pack', 'production.rework'],
    // B-W2b-34: the pay grain for the worker's own records only (the floor routes never show another person's pay).
    grains: ['pay'],
  }),
  floorTemplate('cutting_operator', {
    name: 'Cutting operator',
    description: 'Works at a cutting table on an enrolled floor device; sees only their own pay (the piece rates published to them).',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'production.cut', 'production.bundles', 'production.scan'],
    // B-W2b-34: the pay grain for the worker's own records only (the floor routes never show another person's pay).
    grains: ['pay'],
  }),
  floorTemplate('floor_inspector', {
    name: 'Floor inspector',
    description: 'Inspects work at an inspection bench on an enrolled floor device, and signs and releases the final inspection there with the PIN; sees only their own pay (the piece rates published to them).',
    permissions: ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'production.scan', 'quality.inspections.view', 'quality.inspections.record', 'quality.garments.release', 'production.rework'],
    // B-W2b-34: the pay grain for the worker's own records only (the floor routes never show another person's pay).
    grains: ['pay'],
  }),
  floorTemplate('team_leader', {
    name: 'Team leader',
    description: "Leads a crew on the floor: works and sees the team leader's screens of the device's site; sees only their own pay (the piece rates published to them).",
    permissions: ['floor.work', 'floor.lead', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'inventory.receive', 'production.cut', 'production.bundles', 'production.scan', 'production.serials', 'quality.inspections.view', 'shipping.pack', 'production.rework'],
    // B-W2b-34: the pay grain for the worker's own records only (the floor routes never show another person's pay).
    grains: ['pay'],
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
 * the floor), at most the wages and pay grains (B-W2b-34: a worker's own pay) and no two-factor rule; an office role holds
 * no `floor.*` permission.
 */
export function audienceProblems(role: { readonly audience: RoleAudience } & Pick<RoleContent, 'permissions' | 'grains' | 'requireMfa'>): string[] {
  const floorPermission = (permission: string) => FACTORY_PERMISSIONS.get(permission)?.area === FLOOR_AREA
  const sharedWithFloor = (permission: string) => (FLOOR_SHARED_PERMISSIONS as readonly string[]).includes(permission)
  if (role.audience === 'floor') {
    const problems: string[] = []
    for (const permission of role.permissions) {
      if (!floorPermission(permission) && !sharedWithFloor(permission)) problems.push(`a floor role holds only floor permissions, not ${permission}`)
    }
    for (const grain of role.grains) if (grain !== 'wages' && grain !== 'pay') problems.push(`a floor role sees at most wages and pay, not ${grain}`)
    if (role.requireMfa) problems.push('a floor role cannot require two-factor')
    return problems
  }
  // B-W2b-162: a partner permission (`portal.*`) is held only by partner roles (./partner-templates).
  const partnerPermission = (permission: string) => FACTORY_PERMISSIONS.get(permission)?.partner === true
  return [
    ...role.permissions.filter(floorPermission).map((permission) => `${permission} is held only by floor roles`),
    ...role.permissions.filter(partnerPermission).map((permission) => `${permission} is held only by partner roles`),
  ]
}

const problems = templateProblems(ROLE_TEMPLATES)
if (problems.length > 0) throw new Error(`Role templates are not valid: ${problems.join('; ')}`)

/**
 * B-W2b-162: the partner role templates (./partner-templates.ts: customer, supplier, subcontractor and guest roles and the
 * per-person capabilities), system roles of audience PARTNER in every tenant. A portal step gives its partner permissions
 * to them HERE: one map per step (partner template key → permissions) in PARTNER_ADDS, one line each; the Admin of a kind
 * follows its kind's other roles by itself.
 */
const PARTNER_ADDS: readonly Readonly<Record<string, readonly Permission[]>>[] = [
  // B-W2b-167: every main role sees its Home (tasks, notifications, counts, the live channel); each Admin follows.
  Object.fromEntries(['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'supplier-orders', 'supplier-invoices', 'supplier-quality', 'subcontractor-jobs', 'guest-accountant'].map((key) => [key, ['portal.home.view' as Permission]])),
  // B-W2b-168: every main partner role searches its portal (SAL-084); each Admin follows.
  Object.fromEntries(partnerRoleTemplates().filter((template) => template.kind !== null && !template.admin).map((template) => [template.key, ['portal.search' as Permission]])),
  // B-W2b-185: the customer's Finance sees what is open and pays it online (FIN-118, FIN-123); the customer Admin follows.
  { 'customer-finance': ['portal.payments.view' as Permission, 'portal.payments.pay' as Permission] },
]
export const PARTNER_ROLE_TEMPLATES: readonly PartnerRoleTemplate[] = partnerRoleTemplates(PARTNER_ADDS)
const partnerProblems = partnerTemplateProblems(PARTNER_ROLE_TEMPLATES)
if (partnerProblems.length > 0) throw new Error(`Partner role templates are not valid: ${partnerProblems.join('; ')}`)

/** Every system role a tenant has: the office and floor templates and the partner ones (the API's syncSystemRoles). */
export type SystemRoleTemplate = RoleTemplate | PartnerRoleTemplate
export const SYSTEM_ROLE_TEMPLATES: readonly SystemRoleTemplate[] = Object.freeze([...ROLE_TEMPLATES, ...PARTNER_ROLE_TEMPLATES])
const systemByKey = new Map<string, SystemRoleTemplate>(SYSTEM_ROLE_TEMPLATES.map((entry) => [entry.key, entry]))
const partnerByKey = new Map(PARTNER_ROLE_TEMPLATES.map((entry) => [entry.key, entry]))

/** The template of a system role of any audience (office, floor or partner). `templateOf` stays office and floor. */
export function systemTemplateOf(key: string): SystemRoleTemplate | undefined {
  return systemByKey.get(key)
}

/** A partner template by its key. */
export function partnerTemplateOf(key: string): PartnerRoleTemplate | undefined {
  return partnerByKey.get(key)
}
