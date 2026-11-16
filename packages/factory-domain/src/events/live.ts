import { isUuid } from '../core/ids'
import { can, grantsFor, type Actor, type Permission, type ScopeSet } from '../core/permissions'
import type { EventCatalogue } from './catalogue'
import { isMoneyField, type EventDefinition } from './define'
import type { EventEnvelope, LiveMessage, LiveView } from './envelope'

/**
 * Live screens (plan A1 §3.5), the pure part: which "record changed" message an event becomes, and what one viewer
 * receives of it. The worker publishes `liveMessageFor(...)` on Redis pub/sub; the API's SSE endpoint
 * (apps/factory-api/src/core/sse.ts) sends each connected viewer `liveViewFor(...)`, or nothing.
 */

/** Copies the live rule's fields from the payload; a money-named key is never copied, whatever the rule says. */
function liveFields(definition: EventDefinition, source: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (source === null || typeof source !== 'object') return fields
  for (const key of definition.live?.fields ?? []) {
    if (isMoneyField(key) || !Object.hasOwn(source, key)) continue
    const value = (source as Record<string, unknown>)[key]
    if (value !== undefined) fields[key] = value
  }
  return fields
}

/** B-W2b-GF1 (G165): the payload keys that name the party (customer, supplier, brand) a record is for: one id, or a list. */
export const LIVE_PARTY_KEYS = ['partyId', 'customerId', 'supplierId', 'brandPartyId', 'partyIds'] as const

/** The parties a payload names (every LIVE_PARTY_KEYS value that is a UUID, or a list of them), each once. */
export function livePartiesOf(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return []
  const found = new Set<string>()
  for (const key of LIVE_PARTY_KEYS) {
    if (!Object.hasOwn(payload, key)) continue
    const value = (payload as Record<string, unknown>)[key]
    for (const id of Array.isArray(value) ? value : [value]) if (typeof id === 'string' && isUuid(id)) found.add(id)
  }
  return [...found].sort()
}

/** The live message of a published event, or null when its definition shows nothing on a screen. */
export function liveMessageFor(envelope: EventEnvelope, definition: EventDefinition): LiveMessage | null {
  if (!definition.live || definition.type !== envelope.type || definition.version !== envelope.version) return null
  return {
    tenantId: envelope.tenantId,
    eventId: envelope.eventId,
    type: envelope.type,
    version: envelope.version,
    subject: envelope.subject,
    companyId: envelope.companyId,
    siteId: envelope.siteId,
    occurredAt: envelope.occurredAt,
    fields: liveFields(definition, envelope.payload),
    partyIds: livePartiesOf(envelope.payload),
  }
}

const covers = (set: ScopeSet, id: string | null): boolean => !id || set === 'all' || set.includes(id)

/**
 * B-W2b-GF1 (G165): an office viewer limited to some parties (a sales rep with their customers) receives a message only when
 * every party it names is one of theirs; a message that names none (or comes from an older worker) reaches only a viewer whose
 * grant reaches every party. can() alone lets a record without a party through every party scope, so a party-limited viewer
 * received other parties' record ids.
 */
function reachesParties(viewer: Actor, permission: Permission, record: { readonly companyId: string | null; readonly siteId: string | null }, parties: readonly string[]): boolean {
  const grants = grantsFor(viewer, permission).filter((grant) => covers(grant.companies, record.companyId) && covers(grant.sites, record.siteId))
  if (grants.some((grant) => grant.parties === 'all')) return true
  return parties.length > 0 && parties.every((party) => grants.some((grant) => grant.parties !== 'all' && grant.parties.includes(party)))
}

/**
 * What one viewer receives of a live message, or null. Fails closed:
 *   - another tenant's message, or one whose type and version this catalogue does not declare: nothing;
 *   - an event without a live rule: nothing;
 *   - office: only when can(viewer, rule.permission, { company, site }) (a user limited to some companies or sites sees
 *     only theirs) and, for a user limited to some parties, only when every party the message names is theirs (B-W2b-GF1);
 *   - floor: only an event the rule shows on the floor (`rule.floor`), about the device's own site, and only when
 *     can(viewer, rule.floor, { company, site }): the rule's FLOOR permission, one floor roles hold (B-W2a-F5), never
 *     the office permission (no floor role holds planning.view or quality.holds.view, so asking it closed every tablet);
 *   - any other audience (partner, link, platform, system): nothing (the portal's live feed comes with the portal).
 * The fields are taken again from the API's own catalogue (never trusted from the message) and money never passes.
 */
export function liveViewFor(message: LiveMessage, viewer: Actor, catalogue: EventCatalogue): LiveView | null {
  if (!viewer.tenantId || message.tenantId !== viewer.tenantId) return null
  const definition = catalogue.find(message.type, message.version)
  const rule = definition?.live
  if (!definition || !rule) return null
  const record = { tenantId: message.tenantId, companyId: message.companyId, siteId: message.siteId }
  if (viewer.audience === 'floor') {
    if (!rule.floor || !viewer.siteId || message.siteId !== viewer.siteId) return null
    if (!can(viewer, rule.floor, record)) return null
  } else if (viewer.audience === 'office') {
    if (!can(viewer, rule.permission, record)) return null
    if (!reachesParties(viewer, rule.permission, record, message.partyIds ?? [])) return null
  } else {
    return null
  }
  const { tenantId: _tenant, partyIds: _parties, fields, ...rest } = message
  return { ...rest, fields: liveFields(definition, fields) }
}
