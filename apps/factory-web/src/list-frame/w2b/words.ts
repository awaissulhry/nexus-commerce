import { useMemo } from 'react'
import { BOARD_VIEW_WORDS, type BoardViewWords } from '@nexus/ui/grid/views/board/index'
import { CALENDAR_GRID_WORDS, type CalendarGridWords } from '@nexus/ui/components/CalendarGrid/index'
import { useT } from '../../lib/i18n/provider'

/**
 * The board's and the calendar's DS words in the page's language for the list frame's modes (the same catalogues every
 * board and calendar of the Office reads: `boardview-kit` `board.*`, `calendar-kit` `calendar.*`; B-W2a-24). The texts
 * keep the DS's `{placeholders}`: they go to the part as templates and the part fills them.
 */

export const MODE_NAMESPACES = ['boardview-kit', 'calendar-kit', 'ds-words'] as const

const BOARD_KEYS = Object.keys(BOARD_VIEW_WORDS) as (keyof BoardViewWords)[]
const CALENDAR_KEYS = Object.keys(CALENDAR_GRID_WORDS) as (keyof CalendarGridWords)[]

export function useModeWords(): { board: BoardViewWords; calendar: CalendarGridWords } {
  const board = useT('boardview-kit')
  const calendar = useT('calendar-kit')
  return useMemo(
    () => ({
      board: Object.fromEntries(BOARD_KEYS.map((key) => [key, board(`board.${key}`)])) as unknown as BoardViewWords,
      calendar: Object.fromEntries(CALENDAR_KEYS.map((key) => [key, calendar(`calendar.${key}`)])) as unknown as CalendarGridWords,
    }),
    [board, calendar],
  )
}
