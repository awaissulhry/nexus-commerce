import { z } from 'zod'
import { FACTORY_PERMISSIONS, FLOOR_AREA, FLOOR_SHARED_PERMISSIONS } from '../auth/permissions/catalogue'
import { isPermission, type Permission } from '../core/permissions'

/**
 * Declaring an event (plan A1 §3.4, feature PLT-191; Commerce hard rule 8 for the factory). Every event a command may
 * emit is declared once, by the module that owns it, in `src/<module>/events.ts`:
 *
 *   export const events = [
 *     defineEvent({
 *       type: 'quote.sent',
 *       version: 1,
 *       context: 'sales',
 *       description: 'A quote was sent to the customer.',
 *       payload: z.strictObject({ quoteId: id(), number: z.string() }),
 *       live: { permission: 'quotes.read', fields: ['number'] },
 *     }),
 *   ] as const
 *
 * and `src/events/catalogue.ts` assembles every module's list. The API's outbox writer refuses a type (or a version)
 * that is not in the catalogue, and a payload its strict schema refuses, inside the command's transaction: the change
 * rolls back with it. `scripts/factory/check-event-contract.mjs` finds the same mistakes without running anything.
 *
 * Versions: a breaking payload change is a new definition with the same type and the next version; the old one stays
 * while consumers still read it. Payloads are STRICT objects: an unknown key fails loudly at the writer.
 *
 * Live screens (A1 §3.5): with a `live` rule the event becomes a small "record changed" message on the screens of the
 * users who hold `permission` for the event's company and site (can()). `fields` are payload keys copied into that
 * message (never a money field: the definition is refused). `floor` names the FLOOR permission a floor device's session
 * needs to receive it too, only for an event about the device's own site (B-W2a-F5): a permission floor roles hold
 * (`floor.work`, or one the floor shares with the office such as `production.cut`, `plant.report`), never an office read
 * no floor role holds; `floor: true` is refused. Without `floor` the event never reaches a tablet; without a rule it
 * never reaches a screen.
 */

/** `<module>.<event>`, lower case, words joined by dots or underscores: `quote.sent`, `invoice.sdi_status_changed`. */
const TYPE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/
/** The owning module, as in `src/<module>/`. */
const CONTEXT = /^[a-z][a-z0-9-]*$/
/**
 * Payload keys that name money (the API logger redacts the same words). They never travel on a live screen: a floor
 * device or a user without the money grain must not receive them, and a screen refetches what it shows anyway.
 */
const MONEY = /cost|margin|price|amount|total|wage|salary/i

export class EventDefinitionError extends Error {
  override name = 'EventDefinitionError'
}

/** How an event shows on live screens (A1 §3.5), as a module declares it. */
export interface LiveRule {
  /** The permission an OFFICE viewer needs, checked with can() against the event's company and site. */
  readonly permission: Permission
  /**
   * The floor permission a FLOOR viewer needs (can() against the event's company and site; only events about the
   * device's own site): one floor roles hold (isFloorPermission), never the office read. Default none: the floor never
   * receives it.
   */
  readonly floor?: Permission
  /** Payload keys copied into the live message. Never a money field. Default none. */
  readonly fields?: readonly string[]
}

/** A declared live rule (the definition's `live`): `floor` is null when no tablet receives it. */
export interface LiveRuleDefinition {
  readonly permission: Permission
  readonly floor: Permission | null
  readonly fields: readonly string[]
}

/** A payload schema: a strict zod object. */
export type PayloadSchema = z.ZodObject

export interface EventDefinition<Type extends string = string, Payload extends PayloadSchema = PayloadSchema> {
  readonly type: Type
  /** The payload's schema version, from 1. */
  readonly version: number
  /** The module that owns (and alone emits) the event. */
  readonly context: string
  /** One line: what real-world fact the event records. */
  readonly description: string
  readonly payload: Payload
  /** How it shows on live screens; null: never. */
  readonly live: LiveRuleDefinition | null
}

export interface EventSpec<Type extends string, Payload extends PayloadSchema> {
  readonly type: Type
  /** Default 1. */
  readonly version?: number
  readonly context: string
  readonly description: string
  readonly payload: Payload
  readonly live?: LiveRule
}

/** True for a key that names money (`unitPrice`, `totalMinor`, `costPerM2` …). */
export function isMoneyField(key: string): boolean {
  return MONEY.test(key)
}

/**
 * True for a permission a floor role may hold (auth/roles/templates.ts audienceProblems): one of the floor area
 * (`floor.work`, `floor.lead`) or one the floor shares with the office (FLOOR_SHARED_PERMISSIONS). The only kind a live
 * rule's `floor` may name: an office read no floor role holds would never reach a tablet.
 */
export function isFloorPermission(value: unknown): value is Permission {
  if (!isPermission(value)) return false
  return FACTORY_PERMISSIONS.get(value)?.area === FLOOR_AREA || FLOOR_SHARED_PERMISSIONS.includes(value)
}

/** True when the schema is a zod object that refuses unknown keys (`z.strictObject`). */
export function isStrictObject(schema: unknown): schema is PayloadSchema {
  if (!(schema instanceof z.ZodObject)) return false
  const catchall = (schema.def as { catchall?: { def?: { type?: string } } }).catchall
  return catchall?.def?.type === 'never'
}

/** Declares one event (one version of one type). A malformed declaration throws at import, so at boot. */
export function defineEvent<const Type extends string, Payload extends PayloadSchema>(spec: EventSpec<Type, Payload>): EventDefinition<Type, Payload> {
  const where = `Event ${JSON.stringify(spec?.type)}`
  const problems: string[] = []
  if (typeof spec?.type !== 'string' || !TYPE.test(spec.type)) problems.push('the type is not <module>.<event> (lower case, e.g. quote.sent)')
  const version = spec?.version ?? 1
  if (!Number.isSafeInteger(version) || version < 1) problems.push('the version is not a whole number from 1')
  if (typeof spec?.context !== 'string' || !CONTEXT.test(spec.context)) problems.push('the context is not a module name (lower case)')
  if (typeof spec?.description !== 'string' || spec.description.trim() === '') problems.push('the description is empty')
  if (!isStrictObject(spec?.payload)) problems.push('the payload is not a strict object (z.strictObject)')
  const live = spec?.live
  if (live !== undefined) {
    if (!isPermission(live.permission)) problems.push('live.permission is not <module>.<action>')
    if (live.floor !== undefined && !isFloorPermission(live.floor)) {
      problems.push(
        `live.floor ${JSON.stringify(live.floor)} is not a floor permission: name the permission a floor role holds that the station needs (floor.work, or one shared with the floor such as production.cut or plant.report), never true or an office read`,
      )
    }
    const keys = isStrictObject(spec.payload) ? Object.keys(spec.payload.shape) : []
    for (const field of live.fields ?? []) {
      if (!keys.includes(field)) problems.push(`live field ${JSON.stringify(field)} is not a payload key`)
      else if (isMoneyField(field)) problems.push(`live field ${JSON.stringify(field)} names money; money never travels on a live screen`)
    }
    if (new Set(live.fields ?? []).size !== (live.fields ?? []).length) problems.push('a live field is listed twice')
  }
  if (problems.length > 0) throw new EventDefinitionError(`${where}: ${problems.join('; ')}.`)
  return Object.freeze({
    type: spec.type,
    version,
    context: spec.context,
    description: spec.description,
    payload: spec.payload,
    live: live === undefined ? null : Object.freeze({ permission: live.permission, floor: live.floor ?? null, fields: Object.freeze([...(live.fields ?? [])]) }),
  })
}

/** The payload a definition accepts (before parsing) and returns (after). */
export type EventPayloadInput<Definition extends EventDefinition> = z.input<Definition['payload']>
export type EventPayload<Definition extends EventDefinition> = z.output<Definition['payload']>

/** What a command emits (command()'s CommandEvent), built from a definition so the payload is typed. */
export interface EmittedEvent<Definition extends EventDefinition = EventDefinition> {
  readonly type: Definition['type']
  readonly version: number
  readonly subject: string
  readonly payload: EventPayloadInput<Definition>
  readonly companyId?: string | null
  readonly siteId?: string | null
}

/**
 * The event to pass to command()'s `emit`, typed by its definition: `emit(eventFor(quoteSent, { subject, payload }))`.
 * The outbox writer still checks it against the catalogue (the definition must be assembled there).
 */
export function eventFor<Definition extends EventDefinition>(
  definition: Definition,
  event: { readonly subject: string; readonly payload: EventPayloadInput<Definition>; readonly companyId?: string | null; readonly siteId?: string | null },
): EmittedEvent<Definition> {
  return { type: definition.type, version: definition.version, ...event }
}
