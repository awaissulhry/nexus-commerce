import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES, COMPLAINT_VIEWS, type ComplaintCategory, type ComplaintSeverity, type ComplaintView } from '@nexus/factory-domain/quality/complaints/rules'
import { listComplaints, type ListQuery } from '../../../modules/quality/complaints/list'
import { defineExportSource } from '../source'

/**
 * Quality › Complaints (`/quality/complaints`, the cmp-grid): the export of the list as the screen shows it. The address is
 * the list's own (apps/factory-web areas/quality/complaints model.ts addressOf and queryOf): `?view=` a tile or row
 * (new | safety | dueSoon | open | answeredMonth | closed | all; nothing: open), `?q=`, `?category=`, `?severity=`,
 * `?owner=me`, and a link's `?partyId=`, `?salesOrderId=`, `?shipmentId=`, `?returnId=`. Read through the module's
 * listComplaints (quality.complaints.view, its companies and customers), page by page with its cursor. The order's value
 * is the price grain: absent from the file without it. The CAPA column (always "—" until CAPA, W2b-2) is not written.
 * The owner is named as the screen names them.
 */

type Page = Awaited<ReturnType<typeof listComplaints>>
type Row = Page['complaints'][number] & { readonly ownerName: string | null }
type Query = Omit<ListQuery, 'cursor' | 'limit'>

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined => (value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined)
const idOf = (value: string | null): string | undefined => (value && isUuid(value) ? value : undefined)

export const complaints = defineExportSource<Query, Row>({
  listKey: 'quality.complaints',
  permission: QUALITY_COMPLAINTS_VIEW,
  query(address) {
    const q = (address.get('q') ?? '').trim()
    const view = pick<ComplaintView>(address.get('view'), COMPLAINT_VIEWS)
    const category = pick<ComplaintCategory>(address.get('category'), COMPLAINT_CATEGORIES)
    const severity = pick<ComplaintSeverity>(address.get('severity'), COMPLAINT_SEVERITIES)
    return {
      view: view ?? 'open',
      ...(q ? { q } : {}),
      ...(category ? { category } : {}),
      ...(severity ? { severity } : {}),
      ...(address.get('owner') === 'me' ? { owner: 'me' } : {}),
      ...(idOf(address.get('partyId')) ? { partyId: idOf(address.get('partyId')) } : {}),
      ...(idOf(address.get('salesOrderId')) ? { salesOrderId: idOf(address.get('salesOrderId')) } : {}),
      ...(idOf(address.get('shipmentId')) ? { shipmentId: idOf(address.get('shipmentId')) } : {}),
      ...(idOf(address.get('returnId')) ? { returnId: idOf(address.get('returnId')) } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listComplaints(caller, { ...query, ...(cursor ? { cursor } : {}), limit })
    const names = new Map(page.people.map((person) => [person.id, person.name]))
    return { rows: page.complaints.map((row) => ({ ...row, ownerName: row.ownerId ? (names.get(row.ownerId) ?? null) : null })), next: page.nextCursor }
  },
  columns: {
    complaint: { value: (row) => (row.summary ? `${row.number} · ${row.summary}` : row.number) },
    received: { value: (row) => ({ day: businessDate(new Date(row.receivedAt)) }) },
    customer: { value: (row, words) => (row.customerRef ? `${row.party.legalName} · ${fill(words('row.theirRef'), { ref: row.customerRef })}` : row.party.legalName) },
    order: { value: (row) => (row.order || row.shipment ? [row.order?.number, row.shipment?.number ?? row.return?.number].filter(Boolean).join(' · ') : (row.return?.number ?? null)) },
    garment: {
      value: (row, words) => {
        const style = row.style ? `${row.style.code}${row.size ? ` · ${row.size}` : ''}` : row.size
        const garment = row.serial ? fill(words('garment.serial'), { serial: row.serial }) : row.batchNumber ? fill(words('garment.batch'), { batch: row.batchNumber }) : null
        return [style, garment].filter(Boolean).join(' · ') || null
      },
    },
    category: {
      value: (row, words) =>
        [words(row.category ? `category.${row.category}` : 'category.none'), row.severity ? words(`severity.${row.severity}`) : null, row.safety.state === 'RAISED' ? words('row.notAcknowledged') : null].filter(Boolean).join(' · '),
    },
    status: { value: (row, words) => words(`status.${row.status}`) },
    owner: { value: (row) => row.ownerName },
    due: { value: (row) => (row.answerDueOn ? { day: row.answerDueOn } : null) },
    ncr: { value: (row) => (row.ncrs.length > 0 ? row.ncrs.map((ncr) => ncr.number).join(', ') : null) },
    register: { value: (row, words) => (row.register ? row.register.reference : words('row.notInRegister')) },
    value: { grain: 'price', value: (row) => (row.order ? { minor: Number(row.order.netAmount), currency: row.order.currency } : null) },
  },
  words: {
    it: {
      'status.NEW': 'Nuovo',
      'status.TRIAGED': 'Smistato',
      'status.INVESTIGATING': 'In analisi',
      'status.ANSWERED': 'Risposto',
      'status.CLOSED': 'Chiuso',
      'category.none': 'Non smistato',
      'category.SAFETY': 'Sicurezza',
      'category.FUNCTION': 'Funzione',
      'category.COSMETIC': 'Estetica',
      'category.FIT': 'Vestibilità',
      'severity.MINOR': 'Minore',
      'severity.MAJOR': 'Maggiore',
      'severity.CRITICAL': 'Critica',
      'channel.PHONE': 'Telefono',
      'channel.EMAIL': 'E-mail',
      'channel.PORTAL': 'Portale',
      'channel.LINK': 'Link di reclamo',
      'channel.RETURN': 'Con un reso',
      'channel.VISIT': 'Di persona',
      'due.set': 'Risposta entro',
      'due.overdue_one': 'In ritardo di {count} giorno',
      'due.overdue_other': 'In ritardo di {count} giorni',
      'due.today': 'Scade oggi',
      'due.inDays_one': 'Tra {count} giorno',
      'due.inDays_other': 'Tra {count} giorni',
      'garment.serial': 'Seriale {serial}',
      'garment.batch': 'Lotto {batch}',
      'row.theirRef': 'Loro rif. {ref}',
      'row.notAcknowledged': 'Non preso in carico',
      'row.notInRegister': 'Non nel registro',
    },
    en: {
      'status.NEW': 'New',
      'status.TRIAGED': 'Triaged',
      'status.INVESTIGATING': 'Investigating',
      'status.ANSWERED': 'Answered',
      'status.CLOSED': 'Closed',
      'category.none': 'Not triaged',
      'category.SAFETY': 'Safety',
      'category.FUNCTION': 'Function',
      'category.COSMETIC': 'Cosmetic',
      'category.FIT': 'Fit',
      'severity.MINOR': 'Minor',
      'severity.MAJOR': 'Major',
      'severity.CRITICAL': 'Critical',
      'channel.PHONE': 'Phone',
      'channel.EMAIL': 'E-mail',
      'channel.PORTAL': 'Portal',
      'channel.LINK': 'Claim link',
      'channel.RETURN': 'With a return',
      'channel.VISIT': 'In person',
      'due.set': 'Answer due',
      'due.overdue_one': '{count} day overdue',
      'due.overdue_other': '{count} days overdue',
      'due.today': 'Due today',
      'due.inDays_one': 'In {count} day',
      'due.inDays_other': 'In {count} days',
      'garment.serial': 'Serial {serial}',
      'garment.batch': 'Batch {batch}',
      'row.theirRef': 'Their ref. {ref}',
      'row.notAcknowledged': 'Not acknowledged',
      'row.notInRegister': 'Not in register',
    },
  },
})
