import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, isBusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_INCIDENTS_VIEW } from '@nexus/factory-domain/safety/incidents/permissions'
import { INCIDENT_STATUSES, type IncidentStatus } from '@nexus/factory-domain/safety/incidents/rules'
import { listIncidents, type ListQuery } from '../../../modules/safety/incidents/reads'
import { defineExportSource } from '../source'

/**
 * Plant › Health & safety › Incidents (`/plant/incidents`, SCR-210; B-W2b-149 on B-W2b-125's API; design plant.incidents
 * "⋯ Export (anonymised)", "Export and print are anonymised"): the list as the screen shows it, through the module's own
 * list read (safety.incidents.view over its companies and sites), page by page with its cursor. The address is the list's
 * own (apps/factory-web areas/plant/incidents model.ts): `?rows=INJURY|NEAR_MISS|HAZARD|INAIL_DUE`, `?status=OPEN|CLOSED|
 * CANCELLED|ALL` (nothing: open and closed), `?from=` / `?to=` (the day it happened), `?q=` (the number), `?siteId=`.
 *
 * ANONYMISED (GDPR art. 9; the lead's rule for B-W2b-91's protected tables): no person, no injury, no filing's type, absence
 * or certificate — the row carries none of them, and the screen's "Show people" columns (a recorded read in the page's state
 * only) have no column here, so a file never holds them (an unknown column is left out). The INAIL column is the deadline's
 * state as every view holder sees it on the list (the company's duty, never the type). No money anywhere.
 */

type Page = Awaited<ReturnType<typeof listIncidents>>
type Row = Page['incidents'][number]
type Query = Omit<ListQuery, 'cursor' | 'limit'>

const ROWS = ['INJURY', 'NEAR_MISS', 'HAZARD', 'INAIL_DUE'] as const
const STATUSES = [...INCIDENT_STATUSES, 'ALL'] as const
const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined => (value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined)

/** Where it happened, as the list's Area column says it: the area, the station, the place in words (the machine has its own). */
const whereText = (row: Row): string | null => [row.area?.name, row.station?.code, row.place].filter((part): part is string => Boolean(part && part.trim())).join(' · ') || null

export const incidents = defineExportSource<Query, Row>({
  listKey: 'plant.incidents',
  permission: SAFETY_INCIDENTS_VIEW,
  query(address) {
    const q = (address.get('q') ?? '').trim().slice(0, 40)
    const rows = pick(address.get('rows'), ROWS)
    const status = pick<IncidentStatus | 'ALL'>(address.get('status'), STATUSES)
    const from = address.get('from') ?? ''
    const to = address.get('to') ?? ''
    const siteId = address.get('siteId') ?? ''
    return {
      ...(rows ? { rows } : {}),
      ...(status ? { status } : {}),
      ...(isBusinessDate(from) ? { from } : {}),
      ...(isBusinessDate(to) ? { to } : {}),
      ...(q ? { q } : {}),
      ...(isUuid(siteId) ? { siteId } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listIncidents(caller, { ...query, ...(cursor ? { cursor } : {}), limit })
    return { rows: page.incidents, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    occurredAt: { value: (row) => ({ day: businessDate(new Date(row.occurredAt)) }) },
    site: { value: (row) => `${row.site.code} · ${row.site.name}` },
    where: { value: (row) => whereText(row) },
    machine: { value: (row) => row.machine?.assetNumber ?? null },
    severity: { value: (row, words) => words(`severity.${row.severity ?? 'UNKNOWN'}`) },
    inail: { value: (row, words) => (row.inail.state ? words(`inail.${row.inail.state}`) : null) },
    status: { value: (row, words) => words(`status.${row.status}`) },
    actions: { value: (row) => row.actionsOpen },
  },
  words: {
    it: {
      'kind.INJURY': 'Infortunio',
      'kind.NEAR_MISS': 'Quasi incidente',
      'kind.HAZARD': 'Pericolo',
      'severity.NONE': 'Nessuna lesione',
      'severity.FIRST_AID': 'Primo soccorso',
      'severity.LOST_DAYS': 'Giorni persi',
      'severity.UNKNOWN': 'Da valutare',
      'inail.NOT_NEEDED': 'Non necessaria',
      'inail.WAITING_CERTIFICATE': 'In attesa del certificato',
      'inail.DUE': 'Da inviare',
      'inail.OVERDUE': 'Scaduta',
      'inail.FILED': 'Inviata',
      'status.OPEN': 'Aperto',
      'status.CLOSED': 'Chiuso',
      'status.CANCELLED': 'Annullato',
    },
    en: {
      'kind.INJURY': 'Injury',
      'kind.NEAR_MISS': 'Near miss',
      'kind.HAZARD': 'Hazard',
      'severity.NONE': 'No injury',
      'severity.FIRST_AID': 'First aid',
      'severity.LOST_DAYS': 'Lost days',
      'severity.UNKNOWN': 'To assess',
      'inail.NOT_NEEDED': 'Not needed',
      'inail.WAITING_CERTIFICATE': 'Waiting for the certificate',
      'inail.DUE': 'Due',
      'inail.OVERDUE': 'Overdue',
      'inail.FILED': 'Filed',
      'status.OPEN': 'Open',
      'status.CLOSED': 'Closed',
      'status.CANCELLED': 'Cancelled',
    },
  },
})
