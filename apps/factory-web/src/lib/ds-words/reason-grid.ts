import { useMemo } from 'react'
import { REASON_GRID_WORDS, type ReasonGridWords } from '@nexus/ui/floor/ReasonGrid/index'
import { useT } from '../i18n/provider'
import type { Translate } from '../i18n/messages'

/**
 * The words of the DS icon reason grid (gap D20) in the page's language, from `messages/<locale>/reason-kit.json`
 * (`reasons.*`). In `src/lib` because two views use it: the floor (every "why": scrap, rework, pause, defect, symptom,
 * grade, call type — B-W2a-73…76) and the Office (Plant › Machine requests "Report a problem", B-W2a-53/73); a view may
 * not import another view's files (`check-view-boundaries`). The texts keep the DS's `{placeholders}`: they go to the
 * grid as templates (`t(key)` with no params returns the text as written) and the grid fills them.
 */

export const REASON_KIT_NAMESPACE = 'reason-kit'
export const REASON_WORD_KEYS = Object.keys(REASON_GRID_WORDS) as (keyof ReasonGridWords)[]

export function reasonWordsOf(t: Translate): ReasonGridWords {
  return Object.fromEntries(REASON_WORD_KEYS.map((key) => [key, t(`reasons.${key}`)])) as unknown as ReasonGridWords
}

/** Inside `WithMessages namespaces={[REASON_KIT_NAMESPACE]}` (or a page that loads `reason-kit`). */
export function useReasonWords(): ReasonGridWords {
  const t = useT(REASON_KIT_NAMESPACE)
  return useMemo(() => reasonWordsOf(t), [t])
}
