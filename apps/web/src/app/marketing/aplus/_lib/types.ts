// MC.8.2 — A+ Content shared types. Mirrors the GET /api/aplus-content
// list response shape.

export type AplusStatus =
  | 'DRAFT'
  | 'REVIEW'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'PUBLISHED'
  | 'REJECTED'

export const APLUS_STATUSES: AplusStatus[] = [
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'SUBMITTED',
  'PUBLISHED',
  'REJECTED',
]

export interface AplusContentRow {
  id: string
  name: string
  brand: string | null
  marketplace: string
  locale: string
  status: AplusStatus
  masterContentId: string | null
  amazonDocumentId: string | null
  submittedAt: string | null
  publishedAt: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  _count: {
    modules: number
    asinAttachments: number
    localizations: number
  }
}

export interface AplusModuleRow {
  id: string
  type: string
  position: number
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface AplusAsinRow {
  asin: string
  attachedAt: string
  product: {
    id: string
    sku: string
    name: string
  } | null
}

export interface AplusLocalizationRef {
  id: string
  locale: string
  marketplace: string
  status: AplusStatus
  updatedAt: string
}

export interface AplusMasterRef {
  id: string
  locale: string
  marketplace: string
  status: AplusStatus
}

export interface AplusDetail {
  id: string
  name: string
  brand: string | null
  marketplace: string
  locale: string
  status: AplusStatus
  masterContentId: string | null
  amazonDocumentId: string | null
  submittedAt: string | null
  publishedAt: string | null
  notes: string | null
  scheduledFor: string | null
  createdAt: string
  updatedAt: string
  modules: AplusModuleRow[]
  asinAttachments: AplusAsinRow[]
  localizations: AplusLocalizationRef[]
  master: AplusMasterRef | null
}

// Common Amazon marketplaces — feeds the create-form picker. Add
// additional locales here as the operator needs them; backend
// accepts any string so this is purely a UX convenience list.
export const COMMON_MARKETPLACES: Array<{
  value: string
  label: string
  defaultLocale: string
}> = [
  { value: 'AMAZON_IT', label: 'Amazon Italy', defaultLocale: 'it-IT' },
  { value: 'AMAZON_DE', label: 'Amazon Germany', defaultLocale: 'de-DE' },
  { value: 'AMAZON_UK', label: 'Amazon UK', defaultLocale: 'en-GB' },
  { value: 'AMAZON_FR', label: 'Amazon France', defaultLocale: 'fr-FR' },
  { value: 'AMAZON_ES', label: 'Amazon Spain', defaultLocale: 'es-ES' },
  { value: 'AMAZON_US', label: 'Amazon US', defaultLocale: 'en-US' },
]
