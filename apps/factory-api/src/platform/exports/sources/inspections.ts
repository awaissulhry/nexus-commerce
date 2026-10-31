import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { EXPORT_LIMITS } from '@nexus/factory-domain/views/exports'
import type { CommandCaller } from '../../../core/command'
import { listInspections } from '../../../modules/quality/final/lists'
import { listReleases } from '../../../modules/quality/final/releases'
import { listLots } from '../../../modules/quality/lab/lots'
import { defineExportSource } from '../source'

/**
 * Quality › Inspections (SCR-075, `/quality/inspections`): the export of the list as the screen shows it. The page draws
 * ONE list frame at a time (apps/factory-web areas/quality/inspections view/InspectionsView.tsx), chosen by its view, so
 * all three share the page's list key and this source follows the view the same way (model.ts viewFromAddress):
 *   `?view=all|open|mine|waiting|failed`  inspections (listInspections: `status=OPEN`, `assigned=me`, `waitingRelease`,
 *                                         `failedUndecided`), or a link's own terms `?status=OPEN`, `?assigned=me`,
 *                                         `?waitingRelease=true`, `?failedUndecided=true`
 *   `?view=reversed` (or `?reversed=true`) the releases with garments taken back (listReleases `reversed`)
 *   `?view=lots`                          the material lots on hold (listLots `onHold`; quality.lots.view's scope)
 * Nothing: every inspection. The lists have no cursor: the screen reads up to 200 rows, the file every row (one read).
 * No money. People: who signed or released is said as "you", "at the bench" or "in the office" (never a name in a list,
 * Owner answer W1); an assignee who is an office user is named as the screen names them.
 */

type InspectionRow = Awaited<ReturnType<typeof listInspections>>['inspections'][number]
type ReleaseRow = Awaited<ReturnType<typeof listReleases>>['releases'][number]
type LotRow = Awaited<ReturnType<typeof listLots>>['lots'][number]

type Row =
  | { readonly kind: 'inspections'; readonly me: string; readonly row: InspectionRow }
  | { readonly kind: 'releases'; readonly me: string; readonly row: ReleaseRow }
  | { readonly kind: 'lots'; readonly row: LotRow }

type Query =
  | { readonly kind: 'inspections'; readonly status?: 'OPEN'; readonly waitingRelease?: boolean; readonly failedUndecided?: boolean; readonly assigned?: 'me' }
  | { readonly kind: 'releases' }
  | { readonly kind: 'lots' }

const VIEWS = ['all', 'open', 'mine', 'waiting', 'failed', 'reversed', 'lots'] as const
type View = (typeof VIEWS)[number]

/** The view of an address, as the screen reads it. */
function viewOf(address: URLSearchParams): View {
  const asked = address.get('view')
  if (asked && (VIEWS as readonly string[]).includes(asked)) return asked as View
  if (address.get('failedUndecided') === 'true') return 'failed'
  if (address.get('assigned') === 'me') return 'mine'
  if (address.get('waitingRelease') === 'true') return 'waiting'
  if (address.get('reversed') === 'true') return 'reversed'
  if (address.get('status') === 'OPEN') return 'open'
  return 'all'
}

/** Every row of the view in one read (the lists take a limit, no cursor): more than the file holds is refused by the engine. */
const ALL_ROWS = EXPORT_LIMITS.maxRows + 1

const meOf = (caller: CommandCaller): string => (caller.factoryContext?.audience === 'office' ? caller.factoryContext.actorId : '')
const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
const plural = (words: (code: string) => string, key: string, count: number, params: Readonly<Record<string, string | number>> = {}): string => fill(words(`${key}_${count === 1 ? 'one' : 'other'}`), { count, ...params })

type Who = { readonly kind: 'FLOOR' | 'OFFICE'; readonly userId: string | null }
const whoWords = (who: Who, me: string, words: (code: string) => string): string => words(who.kind === 'FLOOR' ? 'who.bench' : who.userId === me ? 'who.you' : 'who.office')

function statusWords(row: InspectionRow, words: (code: string) => string): string {
  const status =
    row.status === 'OPEN' ? 'status.OPEN' : row.status === 'CANCELLED' ? 'status.CANCELLED' : row.status === 'FAILED' ? 'status.FAILED' : row.onHold && row.reversed > 0 ? 'status.REVERSED' : row.overridden ? 'status.PASSED_OVERRIDE' : 'status.PASSED'
  const parts = [words(status)]
  if (row.undecided) parts.push(words('list.undecided'))
  else if (row.onHold) parts.push(row.status === 'FAILED' ? words('hold.failed') : plural(words, 'hold.reversed', row.reversed))
  if (row.holds > 0 || row.ncrs > 0) parts.push(fill(words('list.decidedIn'), { holds: row.holds, ncrs: row.ncrs }))
  return parts.join(' · ')
}

function assignedWords(row: InspectionRow, me: string, words: (code: string) => string): string | null {
  if (row.status !== 'OPEN') return null
  const assigned = row.assigned
  if (!assigned) return words('assign.nobody')
  if (assigned.kind === 'USER') return assigned.userId === me ? words('assign.you') : assigned.name ? assigned.name : words('assign.office')
  return words('assign.bench')
}

const releasedBack = (row: ReleaseRow): number => row.reversals.reduce((sum, reversal) => sum + reversal.quantity, 0)
const lastReversal = (row: ReleaseRow) => [...row.reversals].sort((a, b) => b.reversedAt.localeCompare(a.reversedAt))[0] ?? null

export const inspections = defineExportSource<Query, Row>({
  listKey: 'quality.inspections',
  permission: QUALITY_INSPECTIONS_VIEW,
  query(address) {
    const view = viewOf(address)
    if (view === 'reversed') return { kind: 'releases' }
    if (view === 'lots') return { kind: 'lots' }
    if (view === 'open') return { kind: 'inspections', status: 'OPEN' }
    if (view === 'mine') return { kind: 'inspections', assigned: 'me' }
    if (view === 'waiting') return { kind: 'inspections', waitingRelease: true }
    if (view === 'failed') return { kind: 'inspections', failedUndecided: true }
    return { kind: 'inspections' }
  },
  async read(caller, query) {
    const me = meOf(caller)
    if (query.kind === 'releases') {
      const page = await listReleases(caller, { reversed: true, limit: ALL_ROWS })
      return { rows: page.releases.map((row) => ({ kind: 'releases' as const, me, row })), next: null }
    }
    if (query.kind === 'lots') {
      const page = await listLots(caller, { onHold: true, limit: ALL_ROWS })
      return { rows: page.lots.map((row) => ({ kind: 'lots' as const, row })), next: null }
    }
    const page = await listInspections(caller, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.waitingRelease ? { waitingRelease: true } : {}),
      ...(query.failedUndecided ? { failedUndecided: true } : {}),
      ...(query.assigned ? { assigned: query.assigned } : {}),
      limit: ALL_ROWS,
    })
    return { rows: page.inspections.map((row) => ({ kind: 'inspections' as const, me, row })), next: null }
  },
  columns: {
    // Inspections
    inspection: { value: (entry) => (entry.kind === 'inspections' ? entry.row.label : null) },
    assigned: { value: (entry, words) => (entry.kind === 'inspections' ? assignedWords(entry.row, entry.me, words) : null) },
    released: { value: (entry, words) => (entry.kind === 'inspections' ? fill(words('list.released'), { released: entry.row.released, lot: entry.row.lotSize }) : null) },
    inspector: { value: (entry, words) => (entry.kind === 'inspections' ? whoWords(entry.row.inspector, entry.me, words) : null) },
    decided: { value: (entry) => (entry.kind === 'inspections' && entry.row.decidedAt ? { at: entry.row.decidedAt } : null) },
    // Inspections and releases: the work order's number.
    workOrder: { value: (entry) => (entry.kind === 'lots' ? null : entry.row.number) },
    // Inspections: the inspection's status; lots: the lot's quality status.
    status: { value: (entry, words) => (entry.kind === 'inspections' ? statusWords(entry.row, words) : entry.kind === 'lots' ? words(`lotStatus.${entry.row.qualityStatus}`) : null) },
    // Inspections: lot and sample size; lots: the lot's code.
    lot: { value: (entry, words) => (entry.kind === 'inspections' ? fill(words('list.lotOf'), { lot: entry.row.lotSize, sample: entry.row.sampleSize }) : entry.kind === 'lots' ? entry.row.code : null) },
    // Releases (the reversed view)
    release: { value: (entry, words) => (entry.kind === 'releases' ? (entry.row.releaseNumber ? fill(words('release.number'), { number: entry.row.releaseNumber }) : fill(words('release.unnumbered'), { workOrder: entry.row.number })) : null) },
    back: {
      value: (entry, words) => {
        if (entry.kind !== 'releases') return null
        const last = lastReversal(entry.row)
        const back = fill(words('list.backOf'), { back: releasedBack(entry.row), released: entry.row.quantity })
        return last ? `${back} · ${words(last.reasonCode ? `reason.${last.reasonCode}` : 'reason.none')}` : back
      },
    },
    by: { value: (entry, words) => (entry.kind === 'releases' ? whoWords(entry.row.releasedBy, entry.me, words) : null) },
    second: { value: (entry, words) => (entry.kind === 'releases' ? (entry.row.secondPerson.reasons.length === 0 ? words('list.alone') : entry.row.secondPerson.reasons.map((reason) => words(`secondPersonShort.${reason}`)).join(' · ')) : null) },
    // Releases: garments still on hold; lots: why the lot is held.
    hold: { value: (entry, words) => (entry.kind === 'releases' ? (entry.row.onHold > 0 ? plural(words, 'list.holdCount', entry.row.onHold) : words('list.holdCleared')) : entry.kind === 'lots' ? (entry.row.hold ?? entry.row.qualityNote ?? null) : null) },
    // Lots on hold
    item: { value: (entry) => (entry.kind === 'lots' ? `${entry.row.item.name} · ${entry.row.item.code}` : null) },
    crvi: { value: (entry, words) => (entry.kind === 'lots' ? words(`crVi.${entry.row.crVi.status}`) : null) },
  },
  words: {
    it: {
      'status.OPEN': 'Aperta',
      'status.PASSED': 'Superata',
      'status.PASSED_OVERRIDE': 'Superata (con deroga)',
      'status.FAILED': 'Non superata',
      'status.CANCELLED': 'Annullata',
      'status.REVERSED': 'Superata · rilascio revocato',
      'list.undecided': 'Non ancora decisa: metti un blocco o apri una non conformità',
      'hold.failed': 'Bloccati: rilavora e ispeziona di nuovo',
      'hold.reversed_one': 'Bloccato: {count} revocato',
      'hold.reversed_other': 'Bloccati: {count} revocati',
      'list.decidedIn': 'Blocchi {holds} · Non conformità {ncrs}',
      'assign.nobody': 'Non assegnata',
      'assign.you': 'Tu',
      'assign.office': "Un ispettore d'ufficio",
      'assign.bench': 'Un ispettore al banco',
      'list.lotOf': 'Lotto {lot} · campione {sample}',
      'list.released': '{released} di {lot} rilasciati',
      'who.you': 'Tu',
      'who.bench': 'Al banco',
      'who.office': 'In ufficio',
      'release.number': 'Rilascio {number}',
      'release.unnumbered': '{workOrder} · rilascio',
      'list.backOf': '{back} di {released} revocati',
      'reason.WRONG_RESULT': 'Esito registrato per errore',
      'reason.DEFECT_FOUND_LATER': 'Difetto trovato dopo',
      'reason.CERTIFICATE_PROBLEM': 'Problema di certificato',
      'reason.CUSTOMER_COMPLAINT': 'Reclamo del cliente',
      'reason.RECALL': 'Richiamo',
      'reason.none': 'Nessun tipo di motivo (record precedente)',
      'list.holdCount_one': '{count} bloccato',
      'list.holdCount_other': '{count} bloccati',
      'list.holdCleared': 'Blocco tolto: una nuova ispezione è superata',
      'list.alone': 'Rilasciato da solo',
      'secondPersonShort.OVERRIDE': 'Seconda persona: deroga',
      'secondPersonShort.CUSTOMER': 'Seconda persona: cliente in elenco',
      'secondPersonShort.ALWAYS': 'Seconda persona: sempre',
      'lotStatus.QUARANTINE': 'In quarantena',
      'lotStatus.RELEASED': 'Rilasciato',
      'lotStatus.REJECTED': 'Respinto',
      'lotStatus.BLOCKED': 'Bloccato',
      'crVi.NOT_REQUIRED': 'Cr VI non richiesto',
      'crVi.PENDING': 'Cr VI in attesa',
      'crVi.PASS': 'Cr VI conforme',
      'crVi.FAIL': 'Cr VI non conforme',
    },
    en: {
      'status.OPEN': 'Open',
      'status.PASSED': 'Passed',
      'status.PASSED_OVERRIDE': 'Passed (override)',
      'status.FAILED': 'Failed',
      'status.CANCELLED': 'Cancelled',
      'status.REVERSED': 'Passed · release taken back',
      'list.undecided': 'Not decided yet: place a hold or create an NCR',
      'hold.failed': 'On hold: rework, inspect again',
      'hold.reversed_one': 'On hold: {count} taken back',
      'hold.reversed_other': 'On hold: {count} taken back',
      'list.decidedIn': 'Holds {holds} · NCRs {ncrs}',
      'assign.nobody': 'Not assigned',
      'assign.you': 'You',
      'assign.office': 'An office inspector',
      'assign.bench': 'A bench inspector',
      'list.lotOf': 'Lot {lot} · sample {sample}',
      'list.released': '{released} of {lot} released',
      'who.you': 'You',
      'who.bench': 'At the bench',
      'who.office': 'In the office',
      'release.number': 'Release {number}',
      'release.unnumbered': '{workOrder} · release',
      'list.backOf': '{back} of {released} taken back',
      'reason.WRONG_RESULT': 'Wrong result recorded',
      'reason.DEFECT_FOUND_LATER': 'Defect found later',
      'reason.CERTIFICATE_PROBLEM': 'Certificate problem',
      'reason.CUSTOMER_COMPLAINT': 'Customer complaint',
      'reason.RECALL': 'Recall',
      'reason.none': 'No reason kind (older record)',
      'list.holdCount_one': '{count} on hold',
      'list.holdCount_other': '{count} on hold',
      'list.holdCleared': 'Hold cleared: a new inspection passed',
      'list.alone': 'Released alone',
      'secondPersonShort.OVERRIDE': 'Second person: override',
      'secondPersonShort.CUSTOMER': 'Second person: listed customer',
      'secondPersonShort.ALWAYS': 'Second person: always',
      'lotStatus.QUARANTINE': 'In quarantine',
      'lotStatus.RELEASED': 'Released',
      'lotStatus.REJECTED': 'Rejected',
      'lotStatus.BLOCKED': 'Blocked',
      'crVi.NOT_REQUIRED': 'Cr VI not required',
      'crVi.PENDING': 'Cr VI waiting',
      'crVi.PASS': 'Cr VI pass',
      'crVi.FAIL': 'Cr VI fail',
    },
  },
})
