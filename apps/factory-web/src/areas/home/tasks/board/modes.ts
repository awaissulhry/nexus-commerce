import type { BoardLane } from '@nexus/ui/grid/views/board/index'
import type { Translate } from '../../../../lib/i18n/messages'
import type { ListMode, ListModes } from '../../../../list-frame/w2b/model'
import type { TaskRow } from '../model'

/**
 * Home › My tasks › Board by status and Calendar by due date (B-W2b-388; design home.tasks sec:tasks "Board by status and Calendar
 * by due date (W2b)"; COL-037/041), on the W2b list frame's modes (B-W2b-13: `?mode=board|calendar`, the same rows, search,
 * tiles and selection as the table). Board lanes are the task's statuses — Open · Done · Cancelled — with the rows' counts; a
 * card moves where the move needs no review: Open → Done (done, as the tick) and Done or Cancelled → Open (reopened); Open →
 * Cancelled is held (a task is cancelled from its popup, where the reason is seen), and nothing moves for a task the person may
 * not change. The calendar puts each task on its due day (tasks without one listed under it); it only reads (the due day
 * changes in the task, or with Set due N: tasks have no bulk-edit target).
 */

export const TASK_LANES = ['OPEN', 'DONE', 'CANCELLED'] as const

/** The modes My tasks offers: the table, the board, the calendar. */
export const TASK_MODES: readonly ListMode[] = ['table', 'board', 'calendar']

export interface TaskModesInput {
  readonly mode: ListMode
  readonly onMode: (mode: ListMode) => void
  /** `home-mywork` words (lane names, held reasons). */
  readonly t: Translate
  /** Why the page holds every change now (offline, a change in flight): words, or null. */
  readonly held: string | null
  readonly onComplete?: (id: string) => void
  readonly onReopen?: (id: string) => void
}

/** Why a task may not move to a lane now (words), or null. */
export function taskMoveHeld(row: Pick<TaskRow, 'status' | 'canChange'>, lane: string, input: Pick<TaskModesInput, 't' | 'held'>): string | null {
  if (!row.canChange) return input.t('board.held.readOnly')
  if (input.held) return input.held
  if (lane === row.status) return null
  if (lane === 'CANCELLED') return input.t('board.held.cancel')
  if (lane === 'DONE' && row.status !== 'OPEN') return input.t('board.held.reopenFirst')
  return null
}

/** The board's lanes with the counts of the rows shown. */
export function taskLanes(rows: readonly Pick<TaskRow, 'status'>[], t: Translate): BoardLane[] {
  return TASK_LANES.map((lane) => ({ id: lane, label: t(`board.lane.${lane}`), total: rows.filter((row) => row.status === lane).length, tone: lane === 'DONE' ? 'success' : lane === 'CANCELLED' ? 'neutral' : 'info' }))
}

/** My tasks' modes for the list frame. */
export function taskModes(rows: readonly TaskRow[], input: TaskModesInput): ListModes<TaskRow> {
  return {
    mode: input.mode,
    onMode: input.onMode,
    board: {
      lanes: taskLanes(rows, input.t),
      laneOf: (row) => row.status,
      // The task's title names the card (the list's first column is its Done box), its record under it.
      card: (row) => ({ label: row.title, title: row.record?.label ?? input.t('board.ownTask'), ...(row.status === 'OPEN' && row.due && row.due.days < 0 ? { marks: [{ label: input.t('board.late'), tone: 'danger' as const }] } : {}) }),
      moveHeld: (row, lane) => taskMoveHeld(row, lane, input),
      onMove: (row, lane) => {
        if (taskMoveHeld(row, lane, input) !== null || lane === row.status) return false
        if (lane === 'DONE') input.onComplete?.(row.id)
        else if (lane === 'OPEN') input.onReopen?.(row.id)
        else return false
        return true
      },
    },
    calendar: { dateOf: (row) => row.dueDate ?? null, label: input.t('board.dueDate') },
  }
}
