import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { SALES_SERVICE_VIEW } from '@nexus/factory-domain/sales/service/permissions'
import { CASE_KINDS, CASE_VIEWS, COVER_STATES, type CaseKind, type CaseView, type CoverState } from '@nexus/factory-domain/sales/service/rules'
import { listCases, type ListQuery } from '../../../modules/sales/service/list'
import { defineExportSource } from '../source'

/**
 * Sales › After-sales › Warranty & service (`/sales/service`, the service.grid; B-W2b-345): the export of the list as the screen
 * shows it. The address is the list's own: `?view=` a tile or saved row (open | new | waitingCustomer | waitingPart | waiting
 * | mine | closed | all; nothing: open), `?q=`, `?kind=`, `?cover=`, `?owner=me`, `?serial=`, a link's `?partyId=`. Read through
 * the module's listCases (sales.service.view, its companies and customers), page by page with its cursor. No amount (a case
 * holds none); never the customer's words but the list's short first line. The owner is named as the screen names them.
 * NOT registered in sources/index.ts yet: the registry test asks for the real Office page at /sales/service, which B-W2b-353
 * builds (it adds the line with the page, as B-W2b-108's CAPA source waited for B-W2b-119).
 */

type Page = Awaited<ReturnType<typeof listCases>>
type Row = Page['cases'][number] & { readonly ownerName: string | null }
type Query = Omit<ListQuery, 'cursor' | 'limit'>

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined => (value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined)
const idOf = (value: string | null): string | undefined => (value && isUuid(value) ? value : undefined)

export const serviceCases = defineExportSource<Query, Row>({
  listKey: 'sales.service',
  permission: SALES_SERVICE_VIEW,
  query(address) {
    const q = (address.get('q') ?? '').trim()
    const serial = (address.get('serial') ?? '').trim()
    const kind = pick<CaseKind>(address.get('kind'), CASE_KINDS)
    const cover = pick<CoverState>(address.get('cover'), COVER_STATES)
    return {
      view: pick<CaseView>(address.get('view'), CASE_VIEWS) ?? 'open',
      ...(q ? { q } : {}),
      ...(serial ? { serial } : {}),
      ...(kind ? { kind } : {}),
      ...(cover ? { cover } : {}),
      ...(address.get('owner') === 'me' ? { owner: 'me' } : {}),
      ...(idOf(address.get('partyId')) ? { partyId: idOf(address.get('partyId')) } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listCases(caller, { ...query, ...(cursor ? { cursor } : {}), limit })
    const names = new Map(page.people.map((person) => [person.id, person.name]))
    return { rows: page.cases.map((row) => ({ ...row, ownerName: row.ownerId ? (names.get(row.ownerId) ?? null) : null })), next: page.nextCursor }
  },
  columns: {
    case: { value: (row) => (row.summary ? `${row.number} · ${row.summary}` : row.number) },
    customer: { value: (row, words) => (row.party ? row.party.legalName : words('customer.none')) },
    serial: { value: (row) => row.garmentSerial ?? row.serial ?? row.garmentBatch ?? row.batchNumber },
    style: { value: (row) => (row.style ? `${row.style.code}${row.size ? ` · ${row.size}` : ''}` : row.size) },
    cover: { value: (row, words) => [words(`cover.${row.cover.state}`), row.cover.decision ? words(`decision.${row.cover.decision}`) : words('decision.none')].join(' · ') },
    status: { value: (row, words) => words(`status.${row.status}`) },
    opened: { value: (row) => ({ day: businessDate(new Date(row.openedAt)) }) },
    owner: { value: (row) => row.ownerName },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
  },
  words: {
    it: {
      'customer.none': 'Cliente non indicato',
      'cover.LEGAL_GUARANTEE': 'Garanzia legale',
      'cover.FACTORY_GUARANTEE': 'Garanzia del produttore',
      'cover.OUT_OF_COVER': 'Fuori garanzia',
      'cover.UNKNOWN': 'Da verificare',
      'decision.COVERED': 'Coperto',
      'decision.PARTLY': 'In parte',
      'decision.NOT_COVERED': 'Non coperto',
      'decision.none': 'Non deciso',
      'status.NEW': 'Nuovo',
      'status.OPEN': 'Aperto',
      'status.WAITING_CUSTOMER': 'In attesa del cliente',
      'status.WAITING_PART': 'In attesa di un ricambio',
      'status.RESOLVED': 'Risolto',
      'status.CLOSED': 'Chiuso',
      'kind.WARRANTY': 'Garanzia',
      'kind.COMPLAINT': 'Reclamo',
      'kind.REPAIR': 'Riparazione',
      'kind.QUESTION': 'Domanda',
      'kind.SAFETY': 'Sicurezza',
    },
    en: {
      'customer.none': 'No customer named',
      'cover.LEGAL_GUARANTEE': 'Legal guarantee',
      'cover.FACTORY_GUARANTEE': 'Factory guarantee',
      'cover.OUT_OF_COVER': 'Out of cover',
      'cover.UNKNOWN': 'To check',
      'decision.COVERED': 'Covered',
      'decision.PARTLY': 'Partly',
      'decision.NOT_COVERED': 'Not covered',
      'decision.none': 'Not decided',
      'status.NEW': 'New',
      'status.OPEN': 'Open',
      'status.WAITING_CUSTOMER': 'Waiting for the customer',
      'status.WAITING_PART': 'Waiting for a part',
      'status.RESOLVED': 'Resolved',
      'status.CLOSED': 'Closed',
      'kind.WARRANTY': 'Warranty',
      'kind.COMPLAINT': 'Complaint',
      'kind.REPAIR': 'Repair',
      'kind.QUESTION': 'Question',
      'kind.SAFETY': 'Safety',
    },
  },
})
