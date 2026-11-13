import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import type { ProfilesQuery } from '@nexus/factory-domain/sales/mtm/contracts'
import { defineExportSource } from '../../../../platform/exports/source'
import { listProfiles } from '../profiles'

/**
 * Sales › Special orders › Made-to-measure (`/sales/made-to-measure`, the mtm.grid; B-W2b-371, XF2:03): the export of the rider list
 * as the screen shows it. The address is the list's own: `?view=` a tile or saved row (all | waiting | needMore | confirmed | old |
 * outside | fittings), `?garment=` a garment type, `?customer=` a customer, `?q=`. Read through the module's listProfiles
 * (sales.measurements.view over the customers), page by page. Never a measure, a note or a photo: the rider, the customer, the
 * garment type, the revision, who measured where and when, the base size, the certified range (its points), the review, the open
 * units, the next fitting, the privacy notice's day. Body data: only a reader of measurements exports it (sales.measurements.view).
 */

type Page = Awaited<ReturnType<typeof listProfiles>>
type Row = Page['rows'][number]
type Query = Omit<ProfilesQuery, 'limit' | 'offset'>

const VIEWS: Readonly<Record<string, Partial<Query>>> = Object.freeze({
  waiting: { review: 'WAITING' },
  needMore: { review: 'NEED_MORE' },
  confirmed: { review: 'CONFIRMED' },
  old: { old: 'true' },
  outside: { range: 'outside' },
  fittings: { fittings: 'week' },
})

const day = (iso: string | null) => (iso ? { day: businessDate(new Date(iso)) } : null)

export const mtmProfiles = defineExportSource<Query, Row>({
  listKey: 'sales.made-to-measure',
  permission: SALES_MEASUREMENTS_VIEW,
  query(address) {
    const q = (address.get('q') ?? '').trim().slice(0, 100)
    const garment = (address.get('garment') ?? '').trim()
    const customer = address.get('customer') ?? ''
    return {
      ...(VIEWS[address.get('view') ?? ''] ?? {}),
      ...(q ? { q } : {}),
      ...(/^[A-Z][A-Z0-9_-]{0,39}$/.test(garment) ? { garmentType: garment } : {}),
      ...(isUuid(customer) ? { partyId: customer } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const offset = cursor ? Number(cursor) : 0
    const page = await listProfiles(caller, { ...query, limit: Math.min(limit, 200), offset })
    const next = offset + page.rows.length
    return { rows: page.rows, next: next < page.matching && page.rows.length > 0 ? String(next) : null }
  },
  async count(caller, query) {
    return (await listProfiles(caller, { ...query, limit: 1, offset: 0 })).matching
  },
  columns: {
    rider: { value: (row, words) => `${row.riderName} (${words(row.byLink ? 'by.link' : 'by.office')})` },
    customer: { value: (row) => `${row.customer.name} · ${row.customer.code}` },
    garment: { value: (row) => row.garmentType },
    revision: { value: (row) => row.revision },
    takenOn: { value: (row) => day(row.takenAt) },
    takenBy: { value: (row) => (row.measuredPlace ? `${row.takenBy} · ${row.measuredPlace}` : row.takenBy) },
    baseSize: { value: (row) => row.baseSize },
    range: { value: (row, words) => (row.range.inside === null ? words('range.unknown') : row.range.inside ? words('range.inside') : `${words('range.outside')}${row.range.points.length > 0 ? `: ${row.range.points.join(', ')}` : ''}`) },
    review: { value: (row, words) => words(`review.${row.review.status}`) },
    openUnits: { value: (row) => row.openUnits },
    nextFitting: { value: (row) => (row.nextFittingAt ? { at: row.nextFittingAt } : null) },
    notice: { value: (row) => day(row.privacyNoticeAt) },
  },
  words: {
    it: {
      'by.link': 'dal link',
      'by.office': 'in ufficio',
      'range.unknown': 'Non verificato',
      'range.inside': 'Nel campo certificato',
      'range.outside': 'Fuori dal campo certificato',
      'review.WAITING': 'In attesa della revisione',
      'review.CONFIRMED': 'Confermate',
      'review.NEED_MORE': 'Serve altro dal pilota',
    },
    en: {
      'by.link': 'by link',
      'by.office': 'in the office',
      'range.unknown': 'Not checked',
      'range.inside': 'Inside the certified range',
      'range.outside': 'Outside the certified range',
      'review.WAITING': 'Waiting for the review',
      'review.CONFIRMED': 'Confirmed',
      'review.NEED_MORE': 'Need more from the rider',
    },
  },
})
