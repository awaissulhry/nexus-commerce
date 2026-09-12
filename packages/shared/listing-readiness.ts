/** Local preparation checks. These results never authorize or confirm a live submission. */
export interface ListingReadinessIssue {
  field: string
  label: string
  kind: 'missing' | 'invalid' | 'translation' | 'schema' | 'account' | 'check' | 'warning'
  message: string
}
export interface ListingReadinessRow {
  id: string
  productId: string
  sku: string
  name: string | null
  channel: string
  marketplace: string
  accountId: string | null
  accountName: string
  aliasKey: string
  locale: string
  category: string | null
  state: 'needs-attention' | 'checks-passed' | 'unavailable'
  issues: ListingReadinessIssue[]
  schema: { version: string | null; fetchedAt: string | null } | null
  savedStatus: string
  lastSyncedAt: string | null
  editorHref: string
}
export interface ListingReadinessPage {
  computedAt: string
  page: number
  pageSize: number
  total: number
  productCount: number
  missingSelectionCount: number
  withoutListing: { total: number; sample: Array<{ id: string; sku: string }> }
  rows: ListingReadinessRow[]
}
