import { events as calendars } from '../calendars/events'
import { events as compliance } from '../compliance/events'
import { events as costing } from '../costing/events'
import { events as email } from '../email/events'
import { events as emailIn } from '../email-in/events'
import { events as files } from '../files/events'
import { events as floorSync } from '../floor-sync/events'
import { events as imports } from '../imports/events'
import { events as insights } from '../insights/events'
import { events as integration } from '../integration/events'
import { events as inventory } from '../inventory/events'
import { events as invoicing } from '../invoicing/events'
import { events as links } from '../links/events'
import { events as parties } from '../parties/events'
import { events as payments } from '../payments/events'
import { events as planning } from '../planning/events'
import { events as threads } from '../threads/events'
import { events as notifications } from '../notifications/events'
import { events as tasks } from '../tasks/events'
import { events as print } from '../print/events'
import { events as privacy } from '../privacy/events'
import { events as purchasing } from '../purchasing/events'
import { events as quality } from '../quality/events'
// B-W2a-18: the reason lists.
import { events as reasons } from '../reasons/events'
import { events as production } from '../production/events'
import { events as product } from '../product/events'
import { events as sales } from '../sales/events'
import { events as shipping } from '../shipping/events'
// B-W2a-23: the exports of the lists.
import { events as views } from '../views/events'
// B-W2a-32: the search index's rebuild.
import { events as search } from '../search/events'
// B-W2a-35: the plant (machines, machine requests, maintenance jobs).
import { events as plant } from '../plant/events'
// B-W2b-96: the requests and jobs in depth (escalation, progress, lock, the lead's confirmation, plant settings).
import { depthEvents as plantDepth } from '../plant/events'
// B-W2a-33: the stored alerts and the date timers.
import { events as alerts } from '../alerts/events'
import { events as timers } from '../timers/events'
// B-W2b-167: tasks and notifications for partners.
import { events as portal } from '../portal/events'
// B-W2a-39: the accounting exports and the period locks.
import { events as accounting } from '../accounting/events'
// B-W2a-36: Security & health (restore drills, two-factor per role).
import { events as ops } from '../ops/events'
// B-W2a-41: the mail delivery log (an address unblocked).
import { events as emailDelivery } from '../email-delivery/events'
// B-W2a-55: receivables (payment reminders, the settings, statements sent).
import { events as receivables } from '../receivables/events'
// B-W2a-62: payables (supplier invoices, the three-way match, approval, payment, SDI pickups).
import { events as payables } from '../payables/events'
// B-W2b-26: people (employees, teams, loans, areas, leaver steps).
// B-W2b-27: people (privacy of people data: the legal gate per site and purpose, the privacy settings).
import { events as people } from '../people/events'
// B-W2b-35: the line's signals (help calls and their types); B-W2b-50: a line's hourly targets and a short hour's reason.
import { events as andon } from '../andon/events'
// B-W2b-49: dispatch every shift.
import { events as dispatch } from '../dispatch/events'
// B-W2b-45: labour records and corrections (line days closed and reopened, disputes).
import { events as labour } from '../labour/events'
// B-W2b-92: inspection plans (a plan changed, a version approved).
import { events as qualityPlans } from '../quality-plans/events'
// B-W2b-97: the final inspection by plan (what the bench recorded).
import { events as qualityFinal } from '../quality-final/events'
// B-W2b-101: inspection triggers (a rule changed, a rule opened an inspection).
import { events as qualityTriggers } from '../quality-triggers/events'
// B-W2b-98: the incoming inspection, hide by hide (opened, recorded, decided, cancelled).
import { events as qualityIncoming } from '../quality-incoming/events'
import { events as qualityInprocess } from '../quality-inprocess/events'
// B-W2b-107: rolls, protector lots and consumables (a roll tagged and changed, a protector lot recorded and withdrawn, a pack).
import { events as inventoryRolls } from '../inventory-rolls/events'
// B-W2b-108: corrective actions, CAPA and 8D (opened, changed, stages, sources, actions, reminders, escalation, the 8D report).
import { events as qualityCapa } from '../quality-capa/events'
// B-W2b-124: statutory periodic checks (a check type, a plan, a result recorded, a check due).
import { events as plantStatutory } from '../plant-statutory/events'
// B-W2b-123: amendments of signed results; the inspection report and the certificate of conformity.
import { events as qualityAmendments } from '../quality-amendments/events'
import { events as qualityDocuments } from '../quality-documents/events'
// B-W2b-120: safety at work (the safety organisation, the RLS notice, the safety calendar's deadlines).
import { events as safety } from '../safety/events'
// B-W2b-118: quality rules (who may sign what and the result rules changed, alert rules changed, an alert rule fired).
import { events as qualityRules } from '../quality-rules/events'
// B-W2b-126: the repair station and second quality.
import { events as productionRepair } from '../production-repair/events'
// B-W2b-122: the risk assessment (versions, signatures, the improvement plan).
import { events as safetyRisk } from '../safety-risk/events'
// B-W2b-125: incidents, near misses and hazards, the INAIL filings (the safety module's own block).
import { incidentEvents as safetyIncidents } from '../safety/events'
// B-W2b-128: role sheets (a sheet applied, a person's role changed).
import { events as safetyRolesheets } from '../safety-rolesheets/events'
// B-W2b-133: the course catalogue and the courses a type of machine asks.
import { events as safetyTraining } from '../safety-training/events'
// B-W2b-134: PPE for workers (an item changed, PPE issued with its receipt, an issue voided).
import { events as safetyPpe } from '../safety-ppe/events'
// B-W2b-143: the chemical register and the safety data sheets.
import { events as safetyChemicals } from '../safety-chemicals/events'
// B-W2b-135: health surveillance (a plan, a visit, a judgement changed: ids and states only).
import { events as safetyHealth } from '../safety-health/events'
// B-W2b-139: training sessions, attendance signed on the floor, training records, the instruction register.
import { events as safetyRecords } from '../safety-records/events'
// B-W2b-161: company branding (a company's logo, accent, sender name or portal label changed).
import { events as branding } from '../branding/events'
// B-W2b-162: partner organisations and their people (portal settings, invitations, changes, access ending soon).
import { events as partners } from '../partners/events'
// B-W2b-185: paying online (payment intents started and finished, the payment link sent).
import { events as paymentIntents } from '../payment-intents/events'
// B-W2b-176: the workshop's answers on its subcontract jobs (accepted, declined, a date answered, kit checked, progress, a send-back).
import { events as subcontractJobs } from '../subcontract-jobs/events'
// B-W2b-190: portal order requests (sent, accepted, refused, withdrawn).
import { events as portalOrdering } from '../portal-ordering/events'
// B-W2b-183: change and cancel requests from the portal (asked, withdrawn, answered).
import { events as salesChangeRequests } from '../sales-change-requests/events'
// B-W2b-182: ship notices (sent, changed, cancelled, received, reopened).
import { events as shipNotices } from '../ship-notices/events'
// B-W2b-189: a supplier's documents and profile in the portal (uploads checked, profile changes decided).
import { events as supplierPortal } from '../supplier-portal/events'
// B-W2b-192: returns and complaints from outside (a return request sent, a claim link made, an answer published, an 8D shared).
import { events as portalReturns } from '../portal-returns/events'
// B-W2b-184: approval requests to partners (asked, answered, withdrawn, expired).
import { events as approvalsOut } from '../approvals-out/events'
// B-W2b-200: inviting a partner to one record (invited, changed, revoked).
import { events as shares } from '../shares/events'
// B-W2b-136 (QHS-173): clicking dies (a die registered, changed or retired).
import { events as plantDies } from '../plant-dies/events'
// B-W2b-208: the textile, leather and origin checks (a check switched on or off).
import { events as textileRules } from '../textile-rules/events'
// B-W2b-221: the style lifecycle, product types and product settings (a move, a type changed, the settings changed).
import { events as productLifecycle } from '../product-lifecycle/events'
// B-W2b-227: styles in depth (a style's text in one language, a GS1 GTIN range).
import { events as stylesDepth } from '../styles-depth/events'
// B-W2b-226: change requests and change orders (raised, changed; a change order changed).
import { events as productChanges } from '../product-changes/events'
// B-W2b-282: one approval engine.
import { events as approvals } from '../approvals/events'
// B-W2b-332: ask to buy (a request asked, a request moved).
import { events as purchaseRequests } from '../purchase-requests/events'
// B-W2b-295: inquiries and requests for quotation.
import { events as salesInquiries } from '../sales-inquiries/events'
// B-W2b-314: the warehouse rules and the adjustments they hold back.
import { events as inventoryRules } from '../inventory-rules/events'
// B-W2b-341: returns in depth (the policy check, fee rules, garments named, credit without a return, the scan code).
import { events as returnsDepth } from '../returns-depth/events'
// B-W2b-346: remakes, exchanges and closing a return (a remake asked, a line split, goods sent back, closed with a reason).
import { events as returnsOutcomes } from '../returns-outcomes/events'
// B-W2b-293: planned work and subcontract orders (planned by a run, made real, made firm).
import { events as planningPlannedOrders } from '../planning-planned-orders/events'
// B-W2b-306: MRP you can trust (action messages raised and decided, planned orders edited, order-specific pegs).
import { events as planningActions } from '../planning-actions/events'
// B-W2b-301: promise dates (an order line's promise per size).
import { events as planningPromise } from '../planning-promise/events'
// B-W2b-317: keeping promises (re-promise proposals and decisions, the ranked backlog, supply too late).
import { events as planningPromiseKeep } from '../planning-promise-keep/events'
// B-W2b-321
import { events as planningSubcontract } from '../planning-subcontract/events'
// B-W2b-331: subcontracting in depth (the written terms, the material balance booked, a workshop charge booked).
import { events as subcontractDepth } from '../subcontract-depth/events'
// B-W2b-325: price lists in depth (breaks and surcharges, a style's own surcharges, minimum order quantities).
import { events as salesPricing } from '../sales-pricing/events'
// B-W2b-294: quotes in depth (a quote template changed, a sent quote expired, its customer reminded before the end).
import { events as quotesDepth } from '../quotes-depth/events'
// B-W2b-303: orders in depth (priority, season, split, confirmation; a quote's season; a company's seasons).
import { events as ordersDepth } from '../orders-depth/events'
// B-W2b-342: repairs and alterations in depth (a request from outside, an estimate sent, answered or withdrawn).
import { events as repairsDepth } from '../repairs-depth/events'
// B-W2b-345: warranty and service cases.
import { events as serviceCases } from '../service-cases/events'
// B-W2b-351: product-safety reports and the accident log.
import { events as safetyReports } from '../safety-reports/events'
// B-W2b-302: quote speed-ups (a size curve changed).
import { events as quoteSpeedups } from '../quote-speedups/events'
// B-W2b-309: order changes (freeze rules, a priced change, the new yes decided, customer-supplied materials).
import { events as orderChanges } from '../order-changes/events'
// B-W2b-358: the made-to-measure office.
import { events as mtmOffice } from '../mtm-office/events'
// B-W2b-360: fittings, alterations and remakes.
import { events as fittings } from '../fittings/events'
// B-W2b-340: the configurator on an order line (its options changed or copied from the quote).
import { events as configurator } from '../configurator/events'
// B-W2b-238: materials in depth (a material's approval decided).
import { events as materialsDepth } from '../materials-depth/events'
// B-W2b-230: the tech pack (a new PDF version of a revision's tech pack kept).
import { events as productTechpack } from '../product-techpack/events'
// B-W2b-246: sample rounds and their shipments.
import { events as salesSamples } from '../sales-samples/events'
// B-W2b-112: cut orders and cut tickets (a cut order changed, a ticket made, printed, scanned or voided, a ply sticker run).
import { events as productionCutorders } from '../production-cutorders/events'
// B-W2b-116: lays at the table (spread, counted), the fabric used at cut finish, a cut order reconciled.
import { events as productionLays } from '../production-lays/events'
// B-W2b-117: after the cut (a recut ticket, a secondary process, a trolley to sewing changed).
import { events as productionCutissue } from '../production-cutissue/events'
// B-W2b-171: measurements by link (a link sent, measurements submitted, body photos deleted).
import { events as measureLink } from '../measure-link/events'
// B-W2b-172: the supplier questionnaire (a version published, a link sent, an answer sent, an answer reviewed).
import { events as supplierQuestionnaire } from '../supplier-questionnaire/events'
// B-W2b-214: work instructions (an instruction changed, a version published, a version seen).
import { events as productionInstructions } from '../production-instructions/events'
// B-W2b-215: SMV versions and an operation's SMV taking an approved version.
import { events as productMinutes } from '../product-minutes/events'
// B-W2b-219: the cutting follow-ups' settings (a site's cutting rules, the leather area tolerance).
import { events as productionCuttingRules } from '../production-cutting-rules/events'
// B-W2b-225: a routing step's quality checkpoint opened a check.
import { events as routingDepth } from '../routing-depth/events'
// B-W2b-224: points of measure, grade rules and the measurement spec (a point or a rule changed, a spec changed).
import { events as productMeasures } from '../product-measures/events'
// B-W2b-229: the option library (a group, its values, rules, effects or prices changed).
import { events as productOptions } from '../product-options/events'
// B-W2b-249: Rules & markets (the register and its change watch, markets, economic operators, phrases and translations).
import { events as complianceRules } from '../compliance-rules/events'
// B-W2b-254: requirements and gates (a requirement changed, a gate refused, a refusal overridden).
import { events as complianceGates } from '../compliance-gates/events'
// B-W2b-233: prepacks (a prepack changed) and protector placement (a draft revision's placement changed).
import { events as productPrepacks } from '../product-prepacks/events'
import { events as productProtectors } from '../product-protectors/events'
// B-W2b-250: restricted substances (the list, its rules, the Candidate List versions, the evaluated material profiles).
import { events as complianceSubstances } from '../compliance-substances/events'
// B-W2b-255: certificates in depth (the notified body directory, a certificate's body, levels, base and bought-in suppliers).
import { events as certificatesDepth } from '../certificates-depth/events'
// B-W2b-251: technical files (a file, an Annex III item, a risk assessment, a production-control test, an evidence pack changed).
import { events as complianceTechfiles } from '../compliance-techfiles/events'
// B-W2b-257: the DoC generator (a generated draft changed, a translation moved, batches recorded, a shipment's pack made).
import { events as complianceDeclarations } from '../compliance-declarations/events'
// B-W2b-252: sample decisions (a round decided or asked, its fit, a CE test result, a swatch changed).
import { events as salesSampleDecisions } from '../sales-sample-decisions/events'
// B-W2b-260: recall, withdrawal and authority (an authority notice, a recall, its progress, a distributor notice, an authority request changed).
import { events as complianceRecall } from '../compliance-recall/events'
// B-W2b-258: the user information builder (a generated leaflet draft changed, a translation moved).
import { events as complianceUserInformation } from '../compliance-user-information/events'
// B-W2b-256: material profiles, supplier declarations and test plans.
import { events as complianceMaterialTests } from '../compliance-material-tests/events'
// B-W2b-259: label artwork (a version added, approved by a second person, retired) and labels logged spoiled or returned.
import { events as complianceLabelArtwork } from '../compliance-label-artwork/events'
// B-W2b-236: a style's pictures and its revisions' pattern files changed.
import { events as productImages } from '../product-images/events'
// B-W2b-263: Time & action (order_gate.changed).
import { events as planningMilestones } from '../planning-milestones/events'
// B-W2b-248: made-to-measure rules.
import { events as productMtm } from '../product-mtm/events'
// B-W2b-264: sourcing & claims (a claim drafted, approved, withdrawn or replaced; a use recorded or ended; evidence expired).
import { events as complianceClaims } from '../compliance-claims/events'
// B-W2b-247: the colour library and the brands' branding sets (colour.changed, branding_set.changed).
import { events as productColours } from '../product-colours/events'
// B-W2b-289: locations in depth (blocks, bin label codes, default locations).
import { events as inventoryLocationsDepth } from '../inventory-locations/events'
// B-W2b-288: the PPE text approvals (a consultant's yes per template recorded or withdrawn; GATE-PPE-TEXTS).
import { events as compliancePpeTexts } from '../compliance-ppe-texts/events'
// B-W2b-313: lots in depth (the lifecycle, shade lots, attributes, the dated trace report).
import { events as lotsDepth } from '../lots-depth/events'
// B-W2b-311: suppliers in depth (supplier.status_changed).
import { events as suppliersDepth } from '../suppliers-depth/events'
// B-W2b-292: the warehouse task inbox.
import { events as inventoryTasks } from '../inventory-tasks/events'
// B-W2b-315: supplier qualification and bank details (supplier_bank_account.*, supplier_qualification.changed, purchase_order.compliance_override_*).
import { events as supplierQualification } from '../supplier-qualification/events'
// B-W2b-377: approvals and buying follow-ups (a held receipt and its release, chase reminders, supplier document types).
import { events as buyingFollowups } from '../buying-followups/events'
// B-W2b-326: transfers between sites (inventory.transfer_changed).
import { events as inventoryTransfers } from '../inventory-transfers/events'
// B-W2b-299: counts in depth (a unit scanned into a count, a count schedule changed or counted).
import { events as inventoryCounts } from '../inventory-counts/events'
// B-W2b-304: credit checks and limits.
import { events as salesCredit } from '../sales-credit/events'
// B-W2b-298: substitutes with a yes (inventory.substitution_changed).
import { events as inventorySubstitutions } from '../inventory-substitutions/events'
// B-W2b-300: goods without a PO and the reception report (inventory.unplanned_changed, inventory.reception_reported).
import { events as inventoryReceiving } from '../inventory-receiving/events'
// B-W2b-371: made-to-measure office photos (measurement_photo.added, .dated, .deleted).
import { events as mtmPhotos } from '../mtm-photos/events'
// B-W2b-384: packing in depth (shipping.carton_packed).
import { events as shippingCartons } from '../shipping-cartons/events'
// B-W2b-386: the shipment queue in depth (shipment.hold_placed, .hold_released, shipment.split, shipping.cut_offs_saved).
import { events as shippingQueue } from '../shipping-queue/events'
// B-W2b-389: currencies and exchange rates (currency.changed, currency.rates_changed).
import { events as currencyEvents } from '../currency/events'
// B-W2b-390: carriers in depth (shipping.test_mode_changed).
import { events as shippingCarriers } from '../shipping-carriers/events'
// B-W2b-394: mail in depth (team inboxes, the capture address, soft bounces, the FAKE mail account's webhook secret).
import { events as mailDepth } from '../mail-depth/events'
import type { EventDefinition } from './define'

/**
 * The event catalogue (plan A1 §3.4, §6.2 "one file per module, assembled"; feature PLT-191): every event any command
 * may emit, one list per module (`src/<module>/events.ts`, `export const events = [...] as const`) assembled below. A
 * module adds its import and its spread to EVENT_DEFINITIONS in the same change that first emits one of its events;
 * `scripts/factory/check-event-contract.mjs` and catalogue.vitest.test.ts fail while a module's list is not assembled.
 *
 * The API's outbox writer (apps/factory-api/src/platform/outbox/writer.ts) checks every emitted event here, inside the
 * command's transaction: an undeclared type or version, or a payload the strict schema refuses, rolls the change back.
 */

export class UndeclaredEventError extends Error {
  override name = 'UndeclaredEventError'
  constructor(
    readonly type: string,
    readonly version: number,
  ) {
    super(
      `Event ${JSON.stringify(type)} version ${version} is not declared in the event catalogue ` +
        '(packages/factory-domain/src/<module>/events.ts, assembled in src/events/catalogue.ts); an undeclared event is never written.',
    )
  }
}

export class EventPayloadError extends Error {
  override name = 'EventPayloadError'
  constructor(
    readonly type: string,
    readonly version: number,
    readonly problems: readonly string[],
  ) {
    super(`The payload of event ${JSON.stringify(type)} version ${version} does not match its schema: ${problems.join('; ')}.`)
  }
}

export interface EventCatalogue {
  /** Every definition, sorted by type and version. */
  readonly definitions: readonly EventDefinition[]
  /** The definition of this type and version, or undefined. */
  find(type: string, version: number): EventDefinition | undefined
  /** The definition, or an UndeclaredEventError. */
  get(type: string, version: number): EventDefinition
  /** The payload as its definition's strict schema parses it; an EventPayloadError (or UndeclaredEventError) otherwise. */
  parse(type: string, version: number, payload: unknown): unknown
  /** Every declared type, sorted, once each. */
  types(): string[]
}

const keyOf = (type: string, version: number): string => `${type}@${version}`

/** A catalogue from definitions. Two definitions of one type and version are refused. */
export function createCatalogue(definitions: readonly EventDefinition[]): EventCatalogue {
  const byKey = new Map<string, EventDefinition>()
  for (const definition of definitions) {
    const key = keyOf(definition.type, definition.version)
    if (byKey.has(key)) throw new Error(`Event ${JSON.stringify(definition.type)} version ${definition.version} is declared twice.`)
    byKey.set(key, definition)
  }
  for (const definition of definitions) {
    const other = definitions.find((entry) => entry.type === definition.type && entry.context !== definition.context)
    if (other) throw new Error(`Event ${JSON.stringify(definition.type)} is declared by two modules (${definition.context}, ${other.context}).`)
  }
  const sorted = Object.freeze(
    [...byKey.values()].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.version - b.version)),
  )
  const get = (type: string, version: number): EventDefinition => {
    const found = byKey.get(keyOf(type, version))
    if (!found) throw new UndeclaredEventError(type, version)
    return found
  }
  return Object.freeze({
    definitions: sorted,
    find: (type: string, version: number) => byKey.get(keyOf(type, version)),
    get,
    parse(type: string, version: number, payload: unknown): unknown {
      const result = get(type, version).payload.safeParse(payload)
      if (!result.success) {
        throw new EventPayloadError(
          type,
          version,
          result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        )
      }
      return result.data
    },
    types: () => [...new Set(sorted.map((definition) => definition.type))],
  })
}

/**
 * Every module's events. Add a module as
 *   import { events as sales } from '../sales/events'
 *   …
 *   ...sales,
 * The platform's own events come first (integration: the inbound webhook ledger; files: confirmed uploads; links: a
 * one-off link's use; threads: messages and mentions on records;
 * imports: the import jobs; print: print jobs; email: mail out and its delivery; email-in: mail received); the W1
 * modules bring theirs (compliance: certificate expiry; product: the material library; inventory: stock moves; parties: customers and suppliers;
 * production: floor rules and work orders; purchasing: purchase orders); floor-sync: the floor tablets' refused queued actions;
 * calendars: the business calendars and shift patterns; reasons: the reason lists.
 * views: the exports of the lists (B-W2a-23).
 * search: the search index's rebuild (B-W2a-32).
 * alerts, timers: the exception rules' stored alerts and the date timers (B-W2a-33).
 * accounting: the accounting exports and the period locks (B-W2a-39).
 * ops: restore drills and the two-factor rule of a role (B-W2a-36).
 */
export const EVENT_DEFINITIONS = [...integration, ...files, ...links, ...threads, ...imports, ...print, ...email, ...emailIn, ...compliance, ...product, ...inventory, ...shipping, ...parties, ...planning, ...purchasing, ...invoicing, ...payments, ...costing, ...production, ...sales, ...privacy, ...quality, ...floorSync, ...insights, ...calendars, ...reasons, ...notifications, ...tasks, ...views, ...search, ...plant, ...plantDepth, ...alerts, ...timers, ...accounting, ...ops,
  // B-W2a-41
  ...emailDelivery,
  // B-W2a-55
  ...receivables,
  // B-W2a-62
  ...payables,
  // B-W2b-26
  // B-W2b-27
  ...people,
  // B-W2b-35
  ...andon,
  // B-W2b-45
  ...labour,
  // B-W2b-49
  ...dispatch,
  // B-W2b-92
  ...qualityPlans,
  // B-W2b-97
  ...qualityFinal,
  // B-W2b-101
  ...qualityTriggers,
  // B-W2b-98
  ...qualityIncoming,
  // B-W2b-99
  ...qualityInprocess,
  // B-W2b-107
  ...inventoryRolls,
  // B-W2b-108
  ...qualityCapa,
  // B-W2b-124
  ...plantStatutory,
  // B-W2b-123
  ...qualityAmendments,
  ...qualityDocuments,
  // B-W2b-120
  ...safety,
  // B-W2b-118
  ...qualityRules,
  // B-W2b-126
  ...productionRepair,
  // B-W2b-122
  ...safetyRisk,
  // B-W2b-125
  ...safetyIncidents,
  // B-W2b-128
  ...safetyRolesheets,
  // B-W2b-133
  ...safetyTraining,
  // B-W2b-134
  ...safetyPpe,
  // B-W2b-143
  ...safetyChemicals,
  // B-W2b-135
  ...safetyHealth,
  // B-W2b-139
  ...safetyRecords,
  // B-W2b-161
  ...branding,
  // B-W2b-162
  ...partners,
  // B-W2b-167
  ...portal,
  // B-W2b-185
  ...paymentIntents,
  // B-W2b-176
  ...subcontractJobs,
  // B-W2b-190
  ...portalOrdering,
  // B-W2b-183
  ...salesChangeRequests,
  // B-W2b-182
  ...shipNotices,
  // B-W2b-189
  ...supplierPortal,
  // B-W2b-192
  ...portalReturns,
  // B-W2b-184
  ...approvalsOut,
  // B-W2b-200
  ...shares,
  // B-W2b-136
  ...plantDies,
  // B-W2b-112
  ...productionCutorders,
  // B-W2b-116
  ...productionLays,
  // B-W2b-117
  ...productionCutissue,
  // B-W2b-171
  ...measureLink,
  // B-W2b-172
  ...supplierQuestionnaire,
  // B-W2b-208
  ...textileRules,
  // B-W2b-214
  ...productionInstructions,
  // B-W2b-215
  ...productMinutes,
  // B-W2b-219
  ...productionCuttingRules,
  // B-W2b-225
  ...routingDepth,
  // B-W2b-221
  ...productLifecycle,
  // B-W2b-227
  ...stylesDepth,
  // B-W2b-224
  ...productMeasures,
  // B-W2b-226
  ...productChanges,
  // B-W2b-229
  ...productOptions,
  // B-W2b-238
  ...materialsDepth,
  // B-W2b-249
  ...complianceRules,
  // B-W2b-254
  ...complianceGates,
  // B-W2b-230
  ...productTechpack,
  // B-W2b-233
  ...productPrepacks,
  ...productProtectors,
  // B-W2b-250
  ...complianceSubstances,
  // B-W2b-255
  ...certificatesDepth,
  // B-W2b-246
  ...salesSamples,
  // B-W2b-251
  ...complianceTechfiles,
  // B-W2b-257
  ...complianceDeclarations,
  // B-W2b-252
  ...salesSampleDecisions,
  // B-W2b-260
  ...complianceRecall,
  // B-W2b-258
  ...complianceUserInformation,
  // B-W2b-256
  ...complianceMaterialTests,
  // B-W2b-259
  ...complianceLabelArtwork,
  // B-W2b-236
  ...productImages,
  // B-W2b-263
  ...planningMilestones,
  // B-W2b-248
  ...productMtm,
  // B-W2b-264
  ...complianceClaims,
  // B-W2b-247
  ...productColours,
  // B-W2b-282
  ...approvals,
  // B-W2b-332
  ...purchaseRequests,
  // B-W2b-289
  ...inventoryLocationsDepth,
  // B-W2b-288
  ...compliancePpeTexts,
  // B-W2b-313
  ...lotsDepth,
  // B-W2b-295
  ...salesInquiries,
  // B-W2b-314
  ...inventoryRules,
  // B-W2b-341
  ...returnsDepth,
  // B-W2b-346
  ...returnsOutcomes,
  // B-W2b-293
  ...planningPlannedOrders,
  ...planningPromise,
  // B-W2b-317
  ...planningPromiseKeep,
  // B-W2b-321
  ...planningSubcontract,
  // B-W2b-311
  ...suppliersDepth,
  // B-W2b-292
  ...inventoryTasks,
  // B-W2b-331
  ...subcontractDepth,
  // B-W2b-315
  ...supplierQualification,
  // B-W2b-325
  ...salesPricing,
  // B-W2b-326
  ...inventoryTransfers,
  // B-W2b-299
  ...inventoryCounts,
  // B-W2b-304
  ...salesCredit,
  // B-W2b-298
  ...inventorySubstitutions,
  // B-W2b-294
  ...quotesDepth,
  // B-W2b-303
  ...ordersDepth,
  // B-W2b-342
  ...repairsDepth,
  // B-W2b-306
  ...planningActions,
  // B-W2b-300
  ...inventoryReceiving,
  // B-W2b-345
  ...serviceCases,
  // B-W2b-351
  ...safetyReports,
  // B-W2b-302
  ...quoteSpeedups,
  // B-W2b-309
  ...orderChanges,
  // B-W2b-358
  ...mtmOffice,
  // B-W2b-360
  ...fittings,
  // B-W2b-340
  ...configurator,
  // B-W2b-371
  ...mtmPhotos,
  // B-W2b-377
  ...buyingFollowups,
  // B-W2b-384
  ...shippingCartons,
  // B-W2b-386
  ...shippingQueue,
  // B-W2b-389
  ...currencyEvents,
  // B-W2b-390
  ...shippingCarriers,
  // B-W2b-394
  ...mailDepth,
] as const satisfies readonly EventDefinition[]

/** Every declared event type. */
export type EventType = (typeof EVENT_DEFINITIONS)[number]['type']

/** The catalogue the API, the worker and the guards use. */
export const EVENT_CATALOGUE: EventCatalogue = createCatalogue(EVENT_DEFINITIONS)
