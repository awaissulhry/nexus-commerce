/**
 * MC.9.4 — Brand Story submission to Amazon SP-API.
 *
 * Sandbox-stub by default per the engagement directive. Mirrors
 * aplus-amazon.service.ts but for the 4 Brand Story module types
 * + Amazon's separate Brand Story endpoint
 * (`/storefront/brand-stories/2023-...`). Real call is intentionally
 * placeholder — needs Brand Registry credentials. Set
 * BRAND_STORY_SUBMISSION_MODE=live to flip.
 */

import type { ValidationResult } from './brand-story-validation.service.js'

export type SubmissionMode = 'sandbox' | 'live'

export function submissionMode(): SubmissionMode {
  return process.env.BRAND_STORY_SUBMISSION_MODE === 'live'
    ? 'live'
    : 'sandbox'
}

interface BrandStoryModule {
  type: string
  payload: Record<string, unknown>
}

interface BrandStoryDocument {
  id: string
  name: string
  brand: string
  marketplace: string
  locale: string
  modules: BrandStoryModule[]
}

const MODULE_TYPE_MAP: Record<string, { amazonType: string; payloadKey: string }> = {
  brand_header: {
    amazonType: 'BRAND_HEADER',
    payloadKey: 'brandHeader',
  },
  featured_asins: {
    amazonType: 'FEATURED_ASINS',
    payloadKey: 'featuredAsins',
  },
  story_focus: {
    amazonType: 'STORY_FOCUS',
    payloadKey: 'storyFocus',
  },
  image_carousel: {
    amazonType: 'IMAGE_CAROUSEL',
    payloadKey: 'imageCarousel',
  },
}

function amazonLocale(locale: string): string {
  return locale.replace('-', '_')
}

export interface SubmissionResponse {
  ok: boolean
  mode: SubmissionMode
  amazonDocumentId: string | null
  rawResponse: Record<string, unknown> | null
  error: string | null
}

export async function submitBrandStoryDocument(
  doc: BrandStoryDocument,
  validation: ValidationResult,
): Promise<SubmissionResponse> {
  if (!validation.ok) {
    return {
      ok: false,
      mode: submissionMode(),
      amazonDocumentId: null,
      rawResponse: null,
      error: `Document has ${validation.blocking.length} blocking validation issue(s); fix and re-submit.`,
    }
  }

  const contentRecord = {
    brandName: doc.brand,
    name: doc.name,
    locale: amazonLocale(doc.locale),
    modules: doc.modules.map((m) => {
      const mapping = MODULE_TYPE_MAP[m.type]
      if (!mapping) return { type: 'UNKNOWN', payload: m.payload }
      return {
        type: mapping.amazonType,
        [mapping.payloadKey]: m.payload,
      }
    }),
  }

  const mode = submissionMode()
  if (mode === 'sandbox') {
    const fakeId =
      'BS' + Math.random().toString(36).slice(2, 10).toUpperCase()
    return {
      ok: true,
      mode: 'sandbox',
      amazonDocumentId: fakeId,
      rawResponse: {
        sandbox: true,
        contentReferenceKey: `${doc.id}-${Date.now()}`,
        record: contentRecord,
      },
      error: null,
    }
  }
  return {
    ok: false,
    mode: 'live',
    amazonDocumentId: null,
    rawResponse: null,
    error:
      'Live Brand Story submission is not yet wired. Set BRAND_STORY_SUBMISSION_MODE=sandbox or wait for the Brand Registry integration.',
  }
}
