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
  // LX.F F2 / R-LX-9 — the fifth member: a coordinate with no ReadinessIndex row
  // reads `notComputed`, which the service can now return (its allowlist derives
  // from `SCOPE_STATES`).
  state: 'ready' | 'warn' | 'blocked' | 'absent' | 'notComputed'
  pct: number | null
  computedAt: string | null
  familyId: string | null
  issues: ListingReadinessIssue[]
  editorHref: string
}
export interface ListingReadinessPage {
  computedAt: string | null
  page: number
  pageSize: number
  total: number
  productCount: number
  rows: ListingReadinessRow[]
}
