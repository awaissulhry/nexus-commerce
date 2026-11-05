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
// B-W2b-161: company branding (a company's logo, accent, sender name or portal label changed).
import { events as branding } from '../branding/events'
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
  // B-W2b-161
  ...branding] as const satisfies readonly EventDefinition[]

/** Every declared event type. */
export type EventType = (typeof EVENT_DEFINITIONS)[number]['type']

/** The catalogue the API, the worker and the guards use. */
export const EVENT_CATALOGUE: EventCatalogue = createCatalogue(EVENT_DEFINITIONS)
