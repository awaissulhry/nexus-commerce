/** Product studio publication uses an explicit account and listing coordinate. */
export interface StudioPublishScope {
  channel: string
  marketplace: string
  accountId: string
  listingId?: string
}

export interface StudioPublishIssue {
  productId?: string
  sku?: string
  field?: string
  message: string
  severity: 'error' | 'warning'
}

export interface StudioPublishReview {
  id: string | null
  productId: string
  scope: StudioPublishScope
  accountLabel: string
  aliasLabel: string
  mode: string
  action: 'create' | 'update'
  rows: Array<{ productId: string; sku: string; title: string; existing: boolean }>
  excluded: number
  issues: StudioPublishIssue[]
  expiresAt: string
  locations?: Array<{ id: string; name: string }>
  visibility?: string
  previousPublicationId?: string
}

export interface StudioPublishResult {
  id: string
  status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'PARTIAL' | 'FAILED' | 'PUBLISHING' | 'UNVERIFIED'
  message: string
  results: Array<{ sku: string; status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'FAILED'; message: string; reference?: string }>
}
