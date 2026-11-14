import { SECURITY_EVENTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { defineExportSource } from '../../exports/source'
import { holdsEverywhere } from '../reads/everywhere'
import { SECURITY_EVENT_KINDS, SECURITY_EVENT_VIEWS, SECURITY_SURFACES, type SecurityEventKindCode, type SecurityEventView } from './contract'
import { eventViewsOf, securityEventsPage, securityEventsWhere, type SecurityEventsQuery } from './read'

/**
 * Admin › Access › Security & health, "Download security events (CSV)" (design admin.security; B-W2b-399, PLT-075): the events
 * as the screen lists them, through the same read (security.events.view over every company). The address: `kind` (one or a
 * comma list), `view` (failed-sign-ins, exports), `surface`, `who`, `ip`, `type` + `record`, `from`, `to`. Newest first. Who is
 * an office or portal person's name, else in words (a floor worker never by name); details as `key: code` pairs.
 */

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined => ((values as readonly string[]).includes(value ?? '') ? (value as T) : undefined)
const idOf = (value: string | null): string | undefined => (value && isUuid(value) ? value : undefined)

const detailText = (details: Record<string, unknown>): string =>
  Object.entries(details)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join('; ')

export const securityEventsExport = defineExportSource<SecurityEventsQuery, SecurityEventView>({
  listKey: 'admin.security',
  permission: SECURITY_EVENTS_VIEW,
  query(address) {
    const kinds = (address.get('kind') ?? '')
      .split(',')
      .map((kind) => kind.trim())
      .filter((kind): kind is SecurityEventKindCode => (SECURITY_EVENT_KINDS as readonly string[]).includes(kind))
    const type = address.get('type')
    return {
      ...(kinds.length > 0 ? { kind: kinds } : {}),
      ...(oneOf(SECURITY_EVENT_VIEWS, address.get('view')) ? { view: oneOf(SECURITY_EVENT_VIEWS, address.get('view')) } : {}),
      ...(oneOf(SECURITY_SURFACES, address.get('surface')) ? { surface: oneOf(SECURITY_SURFACES, address.get('surface')) } : {}),
      ...(idOf(address.get('who')) ? { actorId: idOf(address.get('who')) } : {}),
      ...(address.get('ip') ? { ip: address.get('ip')!.trim().slice(0, 45) } : {}),
      ...(type && /^[A-Z][A-Za-z0-9]{0,63}$/.test(type) ? { recordType: type } : {}),
      ...(idOf(address.get('record')) ? { recordId: idOf(address.get('record')) } : {}),
      ...(address.get('from') ? { from: address.get('from')! } : {}),
      ...(address.get('to') ? { to: address.get('to')! } : {}),
    }
  },
  refusal(actor) {
    return actor.audience === 'office' && holdsEverywhere(actor.grants, SECURITY_EVENTS_VIEW) ? null : 'The security events are exported by the administrators and the Owner only (security.events.view over every company).'
  },
  async read(caller, query, cursor, limit) {
    const where = securityEventsWhere(query)
    return caller.withClient(async (client) => {
      const { rows, nextBefore } = await securityEventsPage(client, where, cursor, limit)
      return { rows: await eventViewsOf(client, rows), next: nextBefore }
    })
  },
  columns: {
    at: { value: (row) => ({ at: row.at }) },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    who: { value: (row, words) => row.actor.name ?? words(`actor.${row.actor.kind}`) },
    surface: { value: (row, words) => words(`surface.${row.surface}`) },
    country: { value: (row) => row.ipCountry },
    result: { value: (row, words) => words(`result.${row.result}`) },
    record: { value: (row) => (row.record ? `${row.record.type} · ${row.record.id}` : null) },
    details: { value: (row) => detailText(row.details) },
  },
  words: {
    it: {
      'kind.SIGN_IN': 'Accesso',
      'kind.SIGN_IN_FAILED': 'Accesso non riuscito',
      'kind.LOCKOUT': 'Blocco',
      'kind.MFA_CHANGED': 'Verifica in due passaggi cambiata',
      'kind.PERMISSION_DENIED': 'Accesso negato',
      'kind.ROLE_CHANGED': 'Ruolo cambiato',
      'kind.API_KEY_USED': 'Chiave API usata',
      'kind.EXPORT': 'Esportazione',
      'kind.STEP_UP_LOCKED': 'Conferma con codice bloccata',
      'actor.PERSON': 'Persona',
      'actor.WORKER': 'Operatore di reparto',
      'actor.LINK': 'Link',
      'actor.SYSTEM': 'Sistema',
      'actor.NOBODY': 'Sconosciuto',
      'surface.OFFICE': 'Ufficio',
      'surface.PORTAL': 'Portale',
      'surface.FLOOR': 'Reparto',
      'surface.LINK': 'Link',
      'surface.API': 'API',
      'surface.SYSTEM': 'Sistema',
      'result.SUCCEEDED': 'Riuscito',
      'result.REFUSED': 'Rifiutato',
      'result.LOCKED': 'Bloccato',
      'result.DONE': 'Fatto',
    },
    en: {
      'kind.SIGN_IN': 'Sign-in',
      'kind.SIGN_IN_FAILED': 'Failed sign-in',
      'kind.LOCKOUT': 'Lockout',
      'kind.MFA_CHANGED': 'Two-factor changed',
      'kind.PERMISSION_DENIED': 'Refused',
      'kind.ROLE_CHANGED': 'Role changed',
      'kind.API_KEY_USED': 'API key used',
      'kind.EXPORT': 'Export',
      'kind.STEP_UP_LOCKED': 'Fresh code locked',
      'actor.PERSON': 'Person',
      'actor.WORKER': 'Floor worker',
      'actor.LINK': 'Link',
      'actor.SYSTEM': 'System',
      'actor.NOBODY': 'Unknown',
      'surface.OFFICE': 'Office',
      'surface.PORTAL': 'Portal',
      'surface.FLOOR': 'Floor',
      'surface.LINK': 'Link',
      'surface.API': 'API',
      'surface.SYSTEM': 'System',
      'result.SUCCEEDED': 'Succeeded',
      'result.REFUSED': 'Refused',
      'result.LOCKED': 'Locked',
      'result.DONE': 'Done',
    },
  },
})
