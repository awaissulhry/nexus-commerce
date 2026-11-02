import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { AT, BOARD, BOARD_LINES } from '../../../../lib/line-board/fixtures'
import { DisplayPreviewView, type DisplayPreviewModel } from './view/DisplayPreviewView'

/**
 * SCR-173-preview — the Office's preview of a line TV (design floor.display › display.preview), a window page in a new tab,
 * with made-up data only: the same board, the bar that picks the line and turns the views, and its states.
 */

const preview = (view: number, over: Partial<DisplayPreviewModel> = {}, boardOver: Partial<DisplayPreviewModel['board']> = {}): DisplayPreviewModel => ({
  board: { board: BOARD, problem: null, view, staleSince: null, clockAt: AT, preview: true, ...boardOver },
  lines: BOARD_LINES,
  lineId: BOARD.line.id,
  paused: false,
  ...over,
})

export const designScreen = defineDesignScreen<DisplayPreviewModel>({
  screen: 'SCR-173-preview',
  title: 'Line TV board: office preview (Production)',
  view: DisplayPreviewView,
  cases: [
    { id: 'preview', label: 'The board of L1, turning', model: preview(0), note: '← and → change the view, Space pauses the rotation.' },
    { id: 'paused', label: 'Paused on the stations', model: preview(1, { paused: true }) },
    { id: 'one-line', label: 'One line: nothing to pick', model: preview(2, { lines: [BOARD_LINES[0]!] }) },
    { id: 'loading', label: 'Reading the lines', model: preview(0, { lines: null, lineId: null }, { board: null }) },
    { id: 'no-lines', label: 'No line to show', model: preview(0, { lines: [], lineId: null }, { board: null }) },
    { id: 'no-permission', label: 'No permission: production.boards.view', model: preview(0, {}, { board: null, problem: 'noAccess' }) },
    { id: 'offline', label: 'The read failed: it keeps trying', model: preview(0, {}, { board: null, problem: 'offline' }) },
    { id: 'stale', label: 'Not updating: the amber band', model: preview(0, {}, { staleSince: AT, problem: 'offline' }) },
  ],
})
