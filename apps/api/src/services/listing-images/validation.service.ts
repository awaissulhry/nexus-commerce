/**
 * Per-platform image validation rules.
 *
 * IR.5.1 — rules moved to @nexus/shared/image-validation so the
 * frontend QualityChecklist + per-cell warnings can read from the
 * same source. This file now adapts the existing ResolvedImage shape
 * (image-resolution.service) into the shared ImageForValidation
 * shape and re-exports the result so existing callers don't change.
 *
 * Honest about scope: we validate what we can see from metadata
 * (count, dimensions when stored, mime type, aspect ratio). White-
 * background and "no text on image" checks need a vision model
 * (IR.6).
 */

import {
  validateImageList,
  PLATFORM_RULES,
  type PlatformKey,
  type PlatformValidationResult as SharedPlatformValidationResult,
  type ValidationIssue as SharedValidationIssue,
} from '@nexus/shared/image-validation'
import type { ResolvedImage } from './image-resolution.service.js'

// Existing callers expect this shape (platform as plain string).
// Re-export the shared types with that ergonomic name preserved.
export type ValidationIssue = SharedValidationIssue
export interface PlatformValidationResult extends Omit<SharedPlatformValidationResult, 'platform'> {
  platform: string
}

export { PLATFORM_RULES }

export function validateForPlatform(
  images: ResolvedImage[],
  platform: string,
  marketplace: string,
): PlatformValidationResult {
  const platformKey = platform.toUpperCase() as PlatformKey
  const result = validateImageList(
    images.map((i) => ({
      url: i.url,
      role: i.role,
      width: i.width,
      height: i.height,
      mimeType: i.mimeType,
    })),
    PLATFORM_RULES[platformKey] ? platformKey : 'AMAZON',
    marketplace,
  )
  return { ...result, platform }
}
