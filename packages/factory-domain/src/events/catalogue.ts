import { events as compliance } from '../compliance/events'
import { events as email } from '../email/events'
import { events as emailIn } from '../email-in/events'
import { events as files } from '../files/events'
import { events as imports } from '../imports/events'
import { events as integration } from '../integration/events'
import { events as inventory } from '../inventory/events'
import { events as links } from '../links/events'
import { events as parties } from '../parties/events'
import { events as planning } from '../planning/events'
import { events as threads } from '../threads/events'
import { events as print } from '../print/events'
import { events as product } from '../product/events'
import { events as shipping } from '../shipping/events'
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
 * modules bring theirs (compliance: certificate expiry; product: the material library; inventory: stock moves; parties: customers and suppliers).
 */
export const EVENT_DEFINITIONS = [...integration, ...files, ...links, ...threads, ...imports, ...print, ...email, ...emailIn, ...compliance, ...product, ...inventory, ...shipping, ...parties, ...planning] as const satisfies readonly EventDefinition[]

/** Every declared event type. */
export type EventType = (typeof EVENT_DEFINITIONS)[number]['type']

/** The catalogue the API, the worker and the guards use. */
export const EVENT_CATALOGUE: EventCatalogue = createCatalogue(EVENT_DEFINITIONS)
