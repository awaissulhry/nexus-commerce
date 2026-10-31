import { isUuid } from '@nexus/factory-domain/core/ids'
import type { ClaimStatus } from '@nexus/factory-domain/purchasing/claims/rules'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { decimalText } from '@nexus/factory-domain/views/exports'
import { listClaims, type ListQuery } from '../../../modules/purchasing/claims/claims'
import { defineExportSource } from '../source'

/**
 * Purchasing › Returns & claims (`/purchasing/claims`): the export of the list as the screen shows it. The address is the
 * list's own (apps/factory-web areas/purchasing/claims model.ts viewFromAddress, filtersOf, claimQuery):
 * `?view=open|draft|sent|accepted|rejected|closed|cancelled|all`, else the API's own `?status=…`, else open (every state
 * for one receipt's or one lot's claims); `?kind=RETURN|CLAIM`, `?receipt=<id>`, `?lot=<id>`, `?q=`. Read through the
 * module's listClaims (purchasing.view, its companies, sites and suppliers), page by page with its cursor. The value of
 * the goods claimed is the cost grain: absent from the file without it.
 */

type Row = Awaited<ReturnType<typeof listClaims>>['items'][number]
type Query = Omit<ListQuery, 'cursor' | 'limit'>

const VIEWS = ['open', 'draft', 'sent', 'accepted', 'rejected', 'closed', 'cancelled', 'all'] as const
type View = (typeof VIEWS)[number]
const VIEW_STATUS: Readonly<Partial<Record<View, ClaimStatus>>> = { draft: 'DRAFT', sent: 'SENT', accepted: 'ACCEPTED', rejected: 'REJECTED', closed: 'CLOSED', cancelled: 'CANCELLED' }

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
const plural = (words: (code: string) => string, key: string, count: number, params: Readonly<Record<string, string | number>> = {}): string => fill(words(`${key}_${count === 1 ? 'one' : 'other'}`), { count, ...params })
/** The file's language, from the words given for it (`lang`: ours, not the catalogue's). */
const langOf = (words: (code: string) => string): 'it' | 'en' => (words('lang') === 'it' ? 'it' : 'en')

export const claims = defineExportSource<Query, Row>({
  listKey: 'purchasing.claims',
  permission: PURCHASING_VIEW,
  query(address) {
    const kindTerm = address.get('kind')
    const receipt = address.get('receipt')
    const lot = address.get('lot')
    const q = (address.get('q') ?? '').trim()
    const asked = address.get('view') ?? ''
    const status = address.get('status')
    const byStatus = (Object.entries(VIEW_STATUS) as [View, ClaimStatus][]).find(([, value]) => value === status)?.[0]
    const view: View = (VIEWS as readonly string[]).includes(asked) ? (asked as View) : (byStatus ?? (receipt || lot ? 'all' : 'open'))
    const viewStatus = VIEW_STATUS[view]
    return {
      ...(viewStatus ? { status: viewStatus } : view === 'all' ? { open: false } : {}),
      ...(kindTerm === 'RETURN' || kindTerm === 'CLAIM' ? { kind: kindTerm } : {}),
      ...(receipt && isUuid(receipt) ? { goodsReceiptId: receipt } : {}),
      ...(lot && isUuid(lot) ? { lotId: lot } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listClaims(caller, { ...query, ...(cursor ? { cursor } : {}), limit })
    return { rows: page.items, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    supplier: { value: (row) => (row.site.code ? `${row.supplier.name} · ${row.site.code}` : row.supplier.name) },
    lot: { value: (row) => (row.lots.length === 0 ? null : row.lots.map((lot) => lot.code).join(', ')) },
    material: { value: (row) => (row.materials.length === 0 ? null : row.materials.map((item) => `${item.code} ${item.name}`).join(' · ')) },
    reason: {
      value: (row, words) => {
        const label = (langOf(words) === 'it' ? row.reason.labelIt : row.reason.labelEn) ?? row.reason.labelEn ?? row.reason.labelIt ?? row.reason.code
        return [label, row.reason.note].filter(Boolean).join(': ') || null
      },
    },
    quantity: {
      value: (row, words) => {
        const amount = row.quantity ? `${decimalText(row.quantity.quantity, langOf(words))} ${words(`uom.${row.quantity.uom}`)}` : plural(words, 'list.lines', row.lines)
        return row.kind === 'RETURN' && row.lines > 0 ? `${amount} · ${fill(words('list.returned'), { returned: row.returned, count: row.lines })}` : amount
      },
    },
    remedy: { value: (row, words) => words(row.remedy ? `remedy.${row.remedy}` : 'remedy.none') },
    value: { grain: 'cost', value: (row) => (row.value === null || row.value === undefined ? null : { minor: Number(row.value), currency: row.currency }) },
    status: { value: (row, words) => words(`status.${row.status}`) },
    age: { value: (row, words) => plural(words, 'list.age', row.ageDays) },
  },
  words: {
    it: {
      lang: 'it',
      'kind.CLAIM': 'Reclamo',
      'kind.RETURN': 'Reso',
      'list.age_one': '{count} giorno',
      'list.age_other': '{count} giorni',
      'list.lines_one': '{count} riga',
      'list.lines_other': '{count} righe',
      'list.returned': '{returned} di {count} resi',
      'remedy.CREDIT': 'Nota di credito',
      'remedy.REPLACEMENT': 'Sostituzione',
      'remedy.none': 'Non ancora scelto',
      'status.ACCEPTED': 'Accettato',
      'status.CANCELLED': 'Annullato',
      'status.CLOSED': 'Chiuso',
      'status.DRAFT': 'Bozza',
      'status.REJECTED': 'Respinto',
      'status.SENT': 'Inviato',
      'uom.BOX': 'scatole',
      'uom.CM': 'cm',
      'uom.CONE': 'coni',
      'uom.DM2': 'dm²',
      'uom.FT2': 'ft²',
      'uom.G': 'g',
      'uom.HIDE': 'pelli',
      'uom.KG': 'kg',
      'uom.L': 'l',
      'uom.M': 'm',
      'uom.M2': 'm²',
      'uom.MM': 'mm',
      'uom.PAIR': 'paio',
      'uom.PCS': 'pz',
      'uom.ROLL': 'rotoli',
      'uom.SET': 'set',
      'uom.SIDE': 'mezze pelli',
    },
    en: {
      lang: 'en',
      'kind.CLAIM': 'Claim',
      'kind.RETURN': 'Return',
      'list.age_one': '{count} day',
      'list.age_other': '{count} days',
      'list.lines_one': '{count} line',
      'list.lines_other': '{count} lines',
      'list.returned': '{returned} of {count} back',
      'remedy.CREDIT': 'Credit note',
      'remedy.REPLACEMENT': 'Replacement',
      'remedy.none': 'Not chosen yet',
      'status.ACCEPTED': 'Accepted',
      'status.CANCELLED': 'Cancelled',
      'status.CLOSED': 'Closed',
      'status.DRAFT': 'Draft',
      'status.REJECTED': 'Rejected',
      'status.SENT': 'Sent',
      'uom.BOX': 'boxes',
      'uom.CM': 'cm',
      'uom.CONE': 'cones',
      'uom.DM2': 'dm²',
      'uom.FT2': 'ft²',
      'uom.G': 'g',
      'uom.HIDE': 'hides',
      'uom.KG': 'kg',
      'uom.L': 'l',
      'uom.M': 'm',
      'uom.M2': 'm²',
      'uom.MM': 'mm',
      'uom.PAIR': 'pair',
      'uom.PCS': 'pcs',
      'uom.ROLL': 'rolls',
      'uom.SET': 'set',
      'uom.SIDE': 'sides',
    },
  },
})
