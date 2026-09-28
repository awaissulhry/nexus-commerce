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
  /** Fresh channel comparison. Missing means this server cannot review sparse publication yet. */
  changes?: StudioPublishChange[]
  skipped?: Array<{ productId: string; sku: string; reason: string }>
  /** Historical content observations, not a live read or a list of changes to be sent. */
  overwrite?: StudioPublishOverwrite
  /**
   * Images rebuild P4c — some fields have problems (every error names its field), so only photo fields may be sent from
   * this review. The problems are in `issues`; a selection with any other field is refused.
   */
  photosOnly?: boolean
}

/** The change-review fields that carry only photos (eBay Trading gallery and colour sets; eBay Inventory's). */
export const PUBLICATION_PHOTO_FIELDS: ReadonlySet<string> = new Set(['pictures', 'Pictures', 'variationPictures'])

/** Whether a change id (`["<productId>","<field>"]`) is a photo field. */
export function isPhotoChangeId(id: string): boolean {
  try {
    const parsed: unknown = JSON.parse(id)
    return Array.isArray(parsed) && typeof parsed[1] === 'string' && PUBLICATION_PHOTO_FIELDS.has(parsed[1])
  } catch { return false }
}

/**
 * The problems that block a publication. When every error names a field, a selection of photo fields only is not
 * blocked by them — it sends no other field (Owner, 2026-09-28: an off-list Season value blocked a photos-only send).
 * An error that names no field (the account, a paused listing, the photo plan's own checks) always blocks.
 */
export function blockingIssues(issues: readonly StudioPublishIssue[], selectedIds?: readonly string[]): StudioPublishIssue[] {
  const errors = issues.filter(i => i.severity === 'error')
  if (!errors.length || errors.some(i => !i.field)) return errors
  return selectedIds?.length && selectedIds.every(isPhotoChangeId) ? [] : errors
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

/** Exact request for one explicit selection, bound to a durable review. */
export interface StudioPublishSelection {
  reviewId: string
  token: string
  selectedIds: string[]
  products: Array<{ productId: string; sku: string }>
  fieldCount: number
  payload: { format: 'json' | 'xml'; content: string }
}
