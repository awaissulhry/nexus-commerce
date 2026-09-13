/** Legacy listing records are not channel observations. Presence has its own vocabulary. */
import { readinessMeta, type ReadinessTone } from './readiness'
export interface ListingStatusMeta { label: string; tone: ReadinessTone; hint: string }
const listed = readinessMeta('live', 'row')
const neutral = readinessMeta('unlisted', 'row').tone
const error = readinessMeta('errors', 'row').tone
const STATUSES: Record<string, ListingStatusMeta> = {
  DRAFT: { label: 'Draft', tone: neutral, hint: 'A draft is recorded here. The channel has not been checked.' },
  ACTIVE: listed,
  LIVE: listed,
  ARCHIVED: { label: 'Archived', tone: neutral, hint: 'Our record says archived. The channel has not been checked.' },
  INACTIVE: { label: 'Inactive', tone: neutral, hint: 'Our record says inactive. The channel has not been checked.' },
  ENDED: { label: 'Ended', tone: neutral, hint: 'Our record says ended. The channel has not been checked.' },
  COMPLETED: { label: 'Ended', tone: neutral, hint: 'Our record says completed. The channel has not been checked.' },
  PENDING: { label: 'Pending', tone: listed.tone, hint: 'A change is pending in our record.' },
  ERROR: { label: 'Error', tone: error, hint: 'Our record carries an error. Read its recorded reason.' },
  FAILED: { label: 'Failed', tone: error, hint: 'Our record carries a failed attempt. Read its recorded reason.' },
  SUPPRESSED: { label: 'Suppressed', tone: error, hint: 'Suppression is recorded here. A fresh channel check may be needed.' },
}
export const LISTING_STATUSES = Object.keys(STATUSES)
export function listingStatusMeta(raw: string | null | undefined): ListingStatusMeta {
  if (raw == null || raw.trim() === '') return { label: 'Not recorded', tone: neutral, hint: 'No listing status is recorded here.' }
  const key = raw.trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(STATUSES, key) ? STATUSES[key] : { label: raw, tone: neutral, hint: `Unrecognised listing status “${raw}”` }
}
