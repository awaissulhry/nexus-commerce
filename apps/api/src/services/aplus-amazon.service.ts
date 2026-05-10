/**
 * MC.8.9 — A+ Content submission to Amazon SP-API.
 *
 * Sandbox-stub by default per the engagement directive: when
 * `APLUS_SUBMISSION_MODE` is unset or === 'sandbox', the submit
 * call short-circuits with a fake documentId so the operator can
 * exercise the full UI flow without touching production. Flip to
 * `live` once an Amazon Brand Registry credential is wired and
 * production posts are explicitly authorised.
 *
 * The Amazon A+ Content API (createContentDocument) accepts a
 * contentRecord with a contentDocument containing:
 *   {
 *     name,
 *     contentType,             // 'EBC' | 'EMC'
 *     contentSubType?,         // 'EBC' for standard, 'EMC_BRAND_STORY' for brand story
 *     locale,                  // 'it_IT', 'de_DE', etc. (note underscore)
 *     contentModuleList: [...] // up to 5 standard / 7 premium
 *   }
 *
 * Each contentModuleList entry is wrapped in a typed envelope:
 *   { contentModuleType: 'STANDARD_HEADER_IMAGE_TEXT', standardHeaderImageText: {...} }
 *
 * This mapping is what we generate from APlusModule.payload below.
 */

import type { ValidationResult } from './aplus-validation.service.js'

export type SubmissionMode = 'sandbox' | 'live'

export function submissionMode(): SubmissionMode {
  return process.env.APLUS_SUBMISSION_MODE === 'live' ? 'live' : 'sandbox'
}

interface AplusModule {
  type: string
  payload: Record<string, unknown>
}

interface AplusDocument {
  id: string
  name: string
  brand: string | null
  marketplace: string
  locale: string
  modules: AplusModule[]
}

export interface SubmissionRequest {
  amazonContentDocument: Record<string, unknown>
  contentReferenceKey: string
  marketplace: string
  locale: string
}

// Map our locale codes (BCP 47) to Amazon's underscore form.
function amazonLocale(locale: string): string {
  return locale.replace('-', '_')
}

// Amazon module-type registry. Maps our internal type names to the
// SP-API contentModuleType + the wrapper key the API expects under
// the payload. Where a module is premium-only Amazon adds the
// PREMIUM_ prefix to the contentModuleType.
const MODULE_TYPE_MAP: Record<
  string,
  { amazonType: string; payloadKey: string }
> = {
  image_header_with_text: {
    amazonType: 'STANDARD_HEADER_IMAGE_TEXT',
    payloadKey: 'standardHeaderImageText',
  },
  standard_image_text: {
    amazonType: 'STANDARD_SINGLE_IMAGE_HIGHLIGHTS',
    payloadKey: 'standardSingleImageHighlights',
  },
  single_image_sidebar: {
    amazonType: 'STANDARD_SINGLE_SIDE_IMAGE',
    payloadKey: 'standardSingleSideImage',
  },
  multiple_image_text_panels: {
    amazonType: 'STANDARD_MULTIPLE_IMAGE_TEXT',
    payloadKey: 'standardMultipleImageText',
  },
  comparison_chart_3col: {
    amazonType: 'STANDARD_COMPARISON_TABLE',
    payloadKey: 'standardComparisonTable',
  },
  comparison_chart_4col: {
    amazonType: 'STANDARD_COMPARISON_TABLE',
    payloadKey: 'standardComparisonTable',
  },
  image_gallery_4: {
    amazonType: 'STANDARD_FOUR_IMAGE_TEXT',
    payloadKey: 'standardFourImageText',
  },
  bulleted_list_with_images: {
    amazonType: 'STANDARD_TEXT_LIST_BLOCK',
    payloadKey: 'standardTextListBlock',
  },
  faq: {
    amazonType: 'STANDARD_FAQS',
    payloadKey: 'standardFaqs',
  },
  premium_video: {
    amazonType: 'PREMIUM_VIDEO',
    payloadKey: 'premiumVideo',
  },
  premium_comparison_chart_8col: {
    amazonType: 'PREMIUM_COMPARISON_TABLE',
    payloadKey: 'premiumComparisonTable',
  },
  premium_image_text_image: {
    amazonType: 'PREMIUM_DOUBLE_HEADER_IMAGE_TEXT',
    payloadKey: 'premiumDoubleHeaderImageText',
  },
  premium_dynamic_carousel: {
    amazonType: 'PREMIUM_DYNAMIC_CAROUSEL',
    payloadKey: 'premiumDynamicCarousel',
  },
  premium_qa: {
    amazonType: 'PREMIUM_QUOTE_BLOCK',
    payloadKey: 'premiumQuoteBlock',
  },
  premium_image_hotspots: {
    amazonType: 'PREMIUM_IMAGE_HOTSPOTS',
    payloadKey: 'premiumImageHotspots',
  },
  premium_text_overlay: {
    amazonType: 'PREMIUM_TEXT_OVERLAY',
    payloadKey: 'premiumTextOverlay',
  },
  premium_brand_story: {
    amazonType: 'PREMIUM_BRAND_STORY',
    payloadKey: 'premiumBrandStory',
  },
}

// Build the Amazon contentRecord shape from our internal document.
// Intentionally lossy: text fields pass through, image asset ids
// become assetIds Amazon expects (operator must have uploaded the
// images via Amazon's image-upload endpoint first; mapping our
// DigitalAsset → Amazon imageRef is MC.12 work). For now the
// payload includes the raw asset ids/URLs and Amazon would reject
// them — the sandbox flow short-circuits before that's an issue.
export function buildSubmissionRequest(
  doc: AplusDocument,
): SubmissionRequest {
  const contentModuleList = doc.modules.map((m) => {
    const mapping = MODULE_TYPE_MAP[m.type]
    if (!mapping) {
      // Unknown type — fall back to passing the payload as-is under a
      // generic key so the sandbox flow can still record the
      // submission. Live mode would re-validate before posting.
      return {
        contentModuleType: 'UNKNOWN',
        unknownModule: m.payload,
      }
    }
    return {
      contentModuleType: mapping.amazonType,
      [mapping.payloadKey]: m.payload,
    }
  })

  const contentDocument = {
    name: doc.name,
    contentType: 'EBC',
    locale: amazonLocale(doc.locale),
    contentModuleList,
  }

  return {
    amazonContentDocument: contentDocument,
    // Amazon requires a contentReferenceKey unique per submission;
    // build from our id + a timestamp suffix so retries don't collide.
    contentReferenceKey: `${doc.id}-${Date.now()}`,
    marketplace: doc.marketplace,
    locale: doc.locale,
  }
}

export interface SubmissionResponse {
  ok: boolean
  mode: SubmissionMode
  amazonDocumentId: string | null
  rawResponse: Record<string, unknown> | null
  error: string | null
}

// Submit to Amazon. In sandbox mode (the default), this returns a
// fake-but-valid response so the UI can exercise the success path
// without touching production. In live mode it would call the SP-
// API client; that branch is intentionally minimal here — wiring
// the live call needs Amazon LWA credentials + region routing,
// which is MC.8.9-followup once a Brand Registry account is
// authorised.
export async function submitAplusDocument(
  doc: AplusDocument,
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
  const request = buildSubmissionRequest(doc)
  const mode = submissionMode()
  if (mode === 'sandbox') {
    // Fake document id mirrors Amazon's format: 8-char alphanumeric.
    const fakeId =
      'AP' +
      Math.random().toString(36).slice(2, 10).toUpperCase()
    return {
      ok: true,
      mode: 'sandbox',
      amazonDocumentId: fakeId,
      rawResponse: {
        sandbox: true,
        contentReferenceKey: request.contentReferenceKey,
        documentRecord: { contentDocument: request.amazonContentDocument },
      },
      error: null,
    }
  }
  // Live submission — placeholder. The real call goes through the
  // Amazon SP-API client; not wired in this commit because (a) it
  // needs Brand Registry credentials and (b) per the engagement
  // directive Amazon submission ships sandbox-only. Returning an
  // explicit "not implemented" lets the UI surface the gap clearly
  // instead of failing silently.
  return {
    ok: false,
    mode: 'live',
    amazonDocumentId: null,
    rawResponse: null,
    error:
      'Live submission is not yet wired. Set APLUS_SUBMISSION_MODE=sandbox or wait for the Brand Registry integration.',
  }
}
