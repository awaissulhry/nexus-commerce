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
  /** Historical content observations, not a live read or a list of changes to be sent. */
  overwrite?: StudioPublishOverwrite
}

export interface StudioPublishOverwrite {
  requiresConfirmation: boolean
  products: Array<{
    productId: string
    sku: string
    status: 'new' | 'not_read' | 'not_compared' | 'compared'
    checkedAt: string | null
    reason?: string
    differing: number
    notCompared: number | null
    omittedDifferences: number
    fields: Array<{ field: string; nexusAtRead: unknown; channelAtRead: unknown; checkedAt: string }>
  }>
}

/** Absence is a known cleared value; unknown never means unchanged or cleared. */
export type StudioPublishValue = { state: 'value'; value: unknown } | { state: 'absent' } | { state: 'unknown'; reason: string }

/** An intentional field write; required preserved collection siblings are not adopted as Nexus changes. */
export interface StudioPublishFieldWrite {
  field: string
  value: Exclude<StudioPublishValue, { state: 'unknown' }>
}

export interface StudioPublishChange {
  id: string
  productId: string
  sku: string
  field: string
  label: string
  current: StudioPublishValue
  lastAccepted: StudioPublishValue
  channel: StudioPublishValue
  status: 'SEND' | 'DIFFERS' | 'CANNOT_COMPARE' | 'SAME'
  localChanged: boolean | null
  channelChanged: boolean | null
  selectable: boolean
  selectedByDefault: boolean
  reason: string
  operation: 'replace' | 'delete' | null
}

export interface StudioPublishResult {
  id: string
  status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'PARTIAL' | 'FAILED' | 'PUBLISHING' | 'UNVERIFIED'
  message: string
  warnings?: string[]
  results: Array<{ sku: string; status: 'SUBMITTED' | 'ACCEPTED' | 'VERIFIED' | 'FAILED'; message: string; reference?: string }>
}
