import { SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import { ROUND_TILES, SAMPLE_KINDS, type RoundTile, type SampleKind } from '@nexus/factory-domain/sales/samples/rules'
import type { RoundListQuery, RoundRow } from '@nexus/factory-domain/sales/samples/contracts'
import { listRounds } from '../../../modules/sales/samples/rounds'
import { defineExportSource } from '../source'

/**
 * Products › Development › Samples & prototypes (`/products/samples`, the list of SCR-110; B-W2b-261 on B-W2b-246's read):
 * the rounds as the list shows them, through the module's own listRounds (sales.samples.view over each round's company and
 * customer; earliest due first, at most 200). The address is the page's: `?tile=` (the API's saved filters), `?kind=`,
 * `?party=` / `?internal=1`, `?style=&revision=`, `?q=`; `?mode=` (board, list, calendar) changes nothing in the file. The
 * columns are the list's (number, style, type, round, customer, revision, stage, due, decision, owner); the owner is said as
 * the list says it ("You" / "A colleague": no name in a list); the charge (a price) is not a column of the list.
 */

type Row = RoundRow & { readonly mine: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOf = (value: string | null): string | undefined => (value && UUID.test(value) ? value : undefined)

const STAGE_WORDS = {
  it: { REQUESTED: 'Richiesto', IN_MAKING: 'In lavorazione', SENT: 'Spedito', UNDER_REVIEW: 'In valutazione', DECIDED: 'Deciso', CANCELLED: 'Annullato' },
  en: { REQUESTED: 'Requested', IN_MAKING: 'In making', SENT: 'Sent', UNDER_REVIEW: 'Under review', DECIDED: 'Decided', CANCELLED: 'Cancelled' },
} as const
const KIND_WORDS = {
  it: { PROTO: 'Prototipo', FIT: 'Fit', SALESMAN: 'Campionario vendita', PRE_PRODUCTION: 'Pre-produzione', CERTIFICATION: 'Campione per prova CE', BRAND: 'Campione del brand' },
  en: { PROTO: 'Proto', FIT: 'Fit', SALESMAN: 'Salesman', PRE_PRODUCTION: 'Pre-production', CERTIFICATION: 'CE test sample', BRAND: 'Brand sample' },
} as const
const DECISION_WORDS = {
  it: { APPROVED: 'Approvato', APPROVED_WITH_COMMENTS: 'Approvato con commenti', REJECTED: 'Respinto' },
  en: { APPROVED: 'Approved', APPROVED_WITH_COMMENTS: 'Approved with comments', REJECTED: 'Rejected' },
} as const
const prefixed = (prefix: string, words: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(words).map(([code, text]) => [`${prefix}.${code}`, text]))

export const sampleRounds = defineExportSource<RoundListQuery, Row>({
  listKey: 'products.samples',
  permission: SALES_SAMPLES_VIEW,
  query(address) {
    const tile = address.get('tile') ?? ''
    const kind = address.get('kind') ?? ''
    const style = idOf(address.get('style'))
    const revision = idOf(address.get('revision'))
    const party = idOf(address.get('party'))
    const internal = address.get('internal') === '1'
    const q = (address.get('q') ?? '').trim().slice(0, 100)
    return {
      ...((ROUND_TILES as readonly string[]).includes(tile) ? { tile: tile as RoundTile } : {}),
      ...((SAMPLE_KINDS as readonly string[]).includes(kind) ? { kind: kind as SampleKind } : {}),
      ...(style ? { styleId: style, ...(revision ? { revisionId: revision } : {}) } : {}),
      ...(internal ? { internal: true } : party ? { partyId: party } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query, _cursor, limit) {
    const me = caller.factoryContext && caller.factoryContext.audience === 'office' ? caller.factoryContext.actorId : null
    const answer = await listRounds(caller, { ...query, limit: Math.min(Math.max(limit, 1), 200) })
    return { rows: answer.rows.map((row) => ({ ...row, mine: row.createdById !== null && row.createdById === me })), next: null }
  },
  columns: {
    number: { value: (row) => row.number },
    style: { value: (row) => `${row.style.code} · ${row.style.name}` },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    round: { value: (row) => row.roundNo },
    customer: { value: (row, words) => row.party?.name ?? words('internal') },
    revision: { value: (row) => row.revision.revision },
    stage: { value: (row, words) => words(`stage.${row.stage}`) },
    due: { value: (row) => row.dueDate },
    decision: { value: (row, words) => (row.decision ? words(`decision.${row.decision}`) : null) },
    owner: { value: (row, words) => (row.createdById === null ? null : words(row.mine ? 'owner.me' : 'owner.other')) },
  },
  words: {
    it: { ...prefixed('stage', STAGE_WORDS.it), ...prefixed('kind', KIND_WORDS.it), ...prefixed('decision', DECISION_WORDS.it), internal: 'Interno', 'owner.me': 'Tu', 'owner.other': 'Un collega' },
    en: { ...prefixed('stage', STAGE_WORDS.en), ...prefixed('kind', KIND_WORDS.en), ...prefixed('decision', DECISION_WORDS.en), internal: 'Internal', 'owner.me': 'You', 'owner.other': 'A colleague' },
  },
})
