import { useMemo } from 'react'
import { PHOTO_CAPTURE_WORDS, type PhotoCaptureWords } from '@nexus/ui/components/PhotoCapture/index'
import { useT } from '../i18n/provider'
import type { Translate } from '../i18n/messages'

/**
 * The words of the DS photo capture with markup (gap D21) in the page's language, from `messages/<locale>/photo-kit.json`
 * (`photo.*`). Every photo step uses them: the floor's photo steps (dock, DDT, machine, defects, returns, final
 * inspection), the office's "Report a problem" (plant.requests) and the link pages (claims, measures). The texts keep
 * the DS's `{placeholders}`: they go to the part as templates (`t(key)` with no params returns the text as written) and
 * the part fills them. It lives in `src/lib` so the Office, Floor and Links views may all import it
 * (`scripts/factory/check-view-boundaries.mjs`, rule 3).
 */

export const PHOTO_KIT_NAMESPACE = 'photo-kit'
export const PHOTO_WORD_KEYS = Object.keys(PHOTO_CAPTURE_WORDS) as (keyof PhotoCaptureWords)[]

export function photoWordsOf(t: Translate): PhotoCaptureWords {
  return Object.fromEntries(PHOTO_WORD_KEYS.map((key) => [key, t(`photo.${key}`)])) as unknown as PhotoCaptureWords
}

/** Inside `WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}`. */
export function usePhotoWords(): PhotoCaptureWords {
  const t = useT(PHOTO_KIT_NAMESPACE)
  return useMemo(() => photoWordsOf(t), [t])
}
