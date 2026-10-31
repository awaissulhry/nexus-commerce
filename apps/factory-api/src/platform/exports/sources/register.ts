import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import type { RegisterKind, RegisterRisk } from '@nexus/factory-domain/compliance/register/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import { EXPORT_LIMITS } from '@nexus/factory-domain/views/exports'
import { listEntries, type ListQuery } from '../../../modules/compliance/register/register'
import { defineExportSource } from '../source'

/**
 * Compliance › PPE register (SCR-113, `/compliance/register`): the export of the register as the screen shows it. The
 * address is the list's own (apps/factory-web areas/compliance/register model.ts addressState and viewQuery):
 * `?view=all|open|risk|assessing|uninformed|closed` with `?kind=COMPLAINT|NON_CONFORMITY|RECALL` and `?risk=NO|ASSESSING|
 * YES` (a view's own risk wins), or a link's `?status=OPEN|CLOSED` (+ `risk`); nothing: every entry. `uninformed` is the
 * open entries whose distributors are not informed yet (the screen filters them the same way). The screen's search box
 * is not kept in its address, so it is not part of a view (named in the notes). Read through the module's listEntries
 * (compliance.register.view, its companies), newest report first; the list has no cursor: one read of every row. No
 * money. The reporter is the customer or supplier who reported it.
 */

type Row = Awaited<ReturnType<typeof listEntries>>['entries'][number]
type Query = Omit<ListQuery, 'limit'> & { readonly uninformed: boolean }

const VIEWS = ['all', 'open', 'risk', 'assessing', 'uninformed', 'closed'] as const
type View = (typeof VIEWS)[number]

/** Every row of the view in one read (no cursor): more than the file holds is refused by the engine. */
const ALL_ROWS = EXPORT_LIMITS.maxRows + 1

const dayOf = (iso: string | null): { day: string } | null => (iso ? { day: businessDate(new Date(iso)) } : null)

export const register = defineExportSource<Query, Row>({
  listKey: 'compliance.register',
  permission: REGISTER_VIEW,
  query(address) {
    const asked = address.get('view') ?? ''
    const status = address.get('status')
    const riskTerm = address.get('risk')
    const kindTerm = address.get('kind')
    const kind: RegisterKind | undefined = kindTerm === 'COMPLAINT' || kindTerm === 'NON_CONFORMITY' || kindTerm === 'RECALL' ? kindTerm : undefined
    const risk: RegisterRisk | undefined = riskTerm === 'NO' || riskTerm === 'ASSESSING' || riskTerm === 'YES' ? riskTerm : undefined
    let view: View = 'all'
    let filterRisk = risk
    if ((VIEWS as readonly string[]).includes(asked)) view = asked as View
    else if (status === 'OPEN' && (risk === 'YES' || risk === 'ASSESSING')) {
      view = risk === 'YES' ? 'risk' : 'assessing'
      filterRisk = undefined
    } else if (status === 'OPEN') view = 'open'
    else if (status === 'CLOSED') view = 'closed'
    const base = { ...(kind ? { kind } : {}), ...(filterRisk ? { risk: filterRisk } : {}), uninformed: false }
    switch (view) {
      case 'open':
        return { ...base, status: 'OPEN' }
      case 'uninformed':
        return { ...base, status: 'OPEN', uninformed: true }
      case 'risk':
        return { ...base, status: 'OPEN', risk: 'YES' }
      case 'assessing':
        return { ...base, status: 'OPEN', risk: 'ASSESSING' }
      case 'closed':
        return { ...base, status: 'CLOSED' }
      default:
        return base
    }
  },
  async read(caller, query) {
    const { uninformed, ...rest } = query
    const { entries } = await listEntries(caller, { ...rest, limit: ALL_ROWS })
    return { rows: uninformed ? entries.filter((row) => row.status === 'OPEN' && row.distributorsInformedAt === null) : entries, next: null }
  },
  columns: {
    entry: { value: (row) => row.reference },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    style: { value: (row) => [row.style.code, row.style.name].filter(Boolean).join(' · ') || null },
    concern: {
      value: (row, words) => {
        if (row.batchNumbers.length > 0) return `${words('list.concern.batch')}: ${row.batchNumbers.join(', ')}`
        if (row.serials.length > 0) return `${words('list.concern.serial')}: ${row.serials.join(', ')}`
        return words('list.noGarments')
      },
    },
    reporter: { value: (row) => row.party?.name ?? null },
    risk: { value: (row, words) => words(`risk.${row.risk}`) },
    source: { value: (row, words) => words(row.source ? `source.${row.source.type}` : 'source.none') },
    status: { value: (row, words) => words(`status.${row.status}`) },
    informed: { value: (row, words) => dayOf(row.distributorsInformedAt) ?? (row.status === 'OPEN' ? words('list.notYet') : null) },
    authority: { value: (row) => (row.authorityNotifiedAt ? (row.authorityReference ? `${businessDate(new Date(row.authorityNotifiedAt))} · ${row.authorityReference}` : dayOf(row.authorityNotifiedAt)) : null) },
  },
  words: {
    it: {
      'kind.COMPLAINT': 'Reclamo',
      'kind.NON_CONFORMITY': 'Non conformità',
      'kind.RECALL': 'Richiamo',
      'risk.NO': 'Nessun rischio',
      'risk.ASSESSING': 'In valutazione',
      'risk.YES': 'Possibile rischio',
      'status.OPEN': 'Aperta',
      'status.CLOSED': 'Chiusa',
      'source.none': 'Aggiunta a mano',
      'source.QualityReleaseReversal': 'Un rilascio annullato',
      'source.QualityRelease': 'Un rilascio',
      'source.Inspection': "Un'ispezione",
      'source.Shipment': 'Una spedizione',
      'source.LabResult': 'Un risultato di laboratorio (Cr VI)',
      'source.Nonconformance': 'Una non conformità (NCR)',
      'source.Complaint': 'Un reclamo del cliente',
      'list.noGarments': 'Nessun lotto o matricola indicati',
      'list.concern.batch': 'Numeri di lotto',
      'list.concern.serial': 'Matricole',
      'list.notYet': 'Non ancora',
    },
    en: {
      'kind.COMPLAINT': 'Complaint',
      'kind.NON_CONFORMITY': 'Non-conformity',
      'kind.RECALL': 'Recall',
      'risk.NO': 'No risk',
      'risk.ASSESSING': 'Being assessed',
      'risk.YES': 'May present a risk',
      'status.OPEN': 'Open',
      'status.CLOSED': 'Closed',
      'source.none': 'Added by hand',
      'source.QualityReleaseReversal': 'A release taken back',
      'source.QualityRelease': 'A release',
      'source.Inspection': 'An inspection',
      'source.Shipment': 'A shipment',
      'source.LabResult': 'A lab result (Cr VI)',
      'source.Nonconformance': 'A nonconformance (NCR)',
      'source.Complaint': 'A customer complaint',
      'list.noGarments': 'No batch or serial named',
      'list.concern.batch': 'Batch numbers',
      'list.concern.serial': 'Serials',
      'list.notYet': 'Not yet',
    },
  },
})
