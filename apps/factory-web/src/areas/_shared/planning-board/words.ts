import { useMemo } from 'react'
import { LOAD_BAR_WORDS, PLANNING_BOARD_WORDS, type LoadBarWords, type PlanningBoardWords } from '@nexus/ui/patterns/planning-board/index'
import { useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'

/**
 * The words of the DS planning board and load bar (gap D18) in the page's language, from `messages/<locale>/board-kit.json`
 * (`board.*`, `load.*`). Every board of the Office uses them: the planning board (SCR-122) and Lines & subcontractors
 * (SCR-126, B-W2a-45). The texts keep the DS's `{placeholders}`: they go to the board as templates (`t(key)` with no
 * params returns the text as written) and the board fills them.
 */

export const BOARD_KIT_NAMESPACE = 'board-kit'
export const BOARD_WORD_KEYS = Object.keys(PLANNING_BOARD_WORDS) as (keyof PlanningBoardWords)[]
export const LOAD_WORD_KEYS = Object.keys(LOAD_BAR_WORDS) as (keyof LoadBarWords)[]

export function boardWordsOf(t: Translate): PlanningBoardWords {
  return Object.fromEntries(BOARD_WORD_KEYS.map((key) => [key, t(`board.${key}`)])) as unknown as PlanningBoardWords
}

export function loadWordsOf(t: Translate): LoadBarWords {
  return Object.fromEntries(LOAD_WORD_KEYS.map((key) => [key, t(`load.${key}`)])) as unknown as LoadBarWords
}

/** Inside `WithMessages namespaces={[BOARD_KIT_NAMESPACE]}`. */
export function useBoardWords(): { board: PlanningBoardWords; load: LoadBarWords } {
  const t = useT(BOARD_KIT_NAMESPACE)
  return useMemo(() => ({ board: boardWordsOf(t), load: loadWordsOf(t) }), [t])
}
