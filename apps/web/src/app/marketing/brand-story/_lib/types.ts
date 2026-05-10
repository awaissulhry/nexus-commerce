// MC.9.1 — Brand Story shared types.
//
// Closely parallels apps/web/.../marketing/aplus/_lib/types.ts.
// Workflow status enum is identical (DRAFT → REVIEW → APPROVED →
// SUBMITTED → PUBLISHED, plus REJECTED). Marketplace + locale
// presets are reused from the A+ Content lib.

export type BrandStoryStatus =
  | 'DRAFT'
  | 'REVIEW'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'PUBLISHED'
  | 'REJECTED'

export const BRAND_STORY_STATUSES: BrandStoryStatus[] = [
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'SUBMITTED',
  'PUBLISHED',
  'REJECTED',
]

export interface BrandStoryRow {
  id: string
  name: string
  brand: string
  marketplace: string
  locale: string
  status: BrandStoryStatus
  masterStoryId: string | null
  amazonDocumentId: string | null
  submittedAt: string | null
  publishedAt: string | null
  notes: string | null
  scheduledFor: string | null
  createdAt: string
  updatedAt: string
  _count: {
    modules: number
    localizations: number
  }
}

export interface BrandStoryModuleRow {
  id: string
  type: string
  position: number
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface BrandStoryLocalizationRef {
  id: string
  locale: string
  marketplace: string
  status: BrandStoryStatus
  updatedAt: string
}

export interface BrandStoryMasterRef {
  id: string
  locale: string
  marketplace: string
  status: BrandStoryStatus
}

export interface BrandStoryDetail {
  id: string
  name: string
  brand: string
  marketplace: string
  locale: string
  status: BrandStoryStatus
  masterStoryId: string | null
  amazonDocumentId: string | null
  submittedAt: string | null
  publishedAt: string | null
  notes: string | null
  scheduledFor: string | null
  createdAt: string
  updatedAt: string
  modules: BrandStoryModuleRow[]
  localizations: BrandStoryLocalizationRef[]
  master: BrandStoryMasterRef | null
}
