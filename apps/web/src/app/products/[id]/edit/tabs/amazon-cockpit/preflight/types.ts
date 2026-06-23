// ALA Phase 8 — Pre-Flight report types (mirror of the API's
// GET /api/products/:id/preflight response shape) + display helpers.

export type PreflightSource =
  | 'byte-length'
  | 'required'
  | 'conditional'
  | 'mirrored'
  | 'validation-preview'

export interface PreflightIssueItem {
  source: PreflightSource
  field: string | null
  severity: 'error' | 'warning'
  message: string
  code?: string
}

export interface PreflightDiffItem {
  field: string
  live: string | null
  pending: string | null
  changed: boolean
}

export interface PreflightListingReport {
  sku: string
  marketplace: string
  productType: string
  counts: { errors: number; warnings: number }
  issues: PreflightIssueItem[]
  diff: PreflightDiffItem[]
  validationPreview: 'ran' | 'skipped' | 'unavailable'
}

export interface PreflightReport {
  productId: string
  marketplace: string | null
  listings: PreflightListingReport[]
  summary: { listings: number; errors: number; warnings: number; blocked: number }
  generatedAt?: string
}

/** Short, human label for an issue's origin — shown as a neutral tag. */
export const SOURCE_LABEL: Record<PreflightSource, string> = {
  'byte-length': 'Length',
  required: 'Required',
  conditional: 'Conditional',
  mirrored: 'Live issue',
  'validation-preview': 'Amazon',
}

/** Friendlier field labels for the diff rows. */
export const FIELD_LABEL: Record<string, string> = {
  item_name: 'Title',
  price: 'Price',
  quantity: 'Quantity',
}
