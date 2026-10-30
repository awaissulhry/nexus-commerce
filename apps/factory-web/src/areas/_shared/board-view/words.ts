import { useMemo } from 'react'
import { BOARD_VIEW_WORDS, type BoardViewWords } from '@nexus/ui/grid/views/board/index'
import { useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'

/**
 * The words of the DS board view of a list (gap D19) in the page's language, from `messages/<locale>/boardview-kit.json`
 * (`board.*`). Every board of the Office uses them: the NCR board (SCR-145, B-W2a-68), the hold board (SCR-078/079,
 * B-W2a-67) and later W2b boards (receipts, maintenance jobs, samples). The texts keep the DS's `{placeholders}`: they go
 * to the board as templates (`t(key)` with no params returns the text as written) and the board fills them.
 */

export const BOARD_VIEW_KIT_NAMESPACE = 'boardview-kit'
export const BOARD_VIEW_WORD_KEYS = Object.keys(BOARD_VIEW_WORDS) as (keyof BoardViewWords)[]

export function boardViewWordsOf(t: Translate): BoardViewWords {
  return Object.fromEntries(BOARD_VIEW_WORD_KEYS.map((key) => [key, t(`board.${key}`)])) as unknown as BoardViewWords
}

/** Inside `WithMessages namespaces={[BOARD_VIEW_KIT_NAMESPACE]}`. */
export function useBoardViewWords(): BoardViewWords {
  const t = useT(BOARD_VIEW_KIT_NAMESPACE)
  return useMemo(() => boardViewWordsOf(t), [t])
}
