import { createElement } from 'react'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { AT, BOARD, EMPTY_BOARD, MANY_STATIONS_BOARD, NO_TARGET_BOARD } from '../../lib/line-board/fixtures'
import { LineBoardView, type LineBoardModel } from '../../lib/line-board/view/LineBoardView'
import { WithMessages } from '../../record-panels/i18n'

/**
 * SCR-173 — the line TV board (design floor.display; ANA-007, MES-147, MES-166; Owner answer F2) with made-up data only:
 * the three views, a stale board's amber band, a line without targets, an empty day, and each reason there is no board.
 * Nobody is signed in, and nothing on it can be pressed. The clock stands still in the cases; on the wall it ticks.
 */

const board = (view: number, over: Partial<LineBoardModel> = {}): LineBoardModel => ({ board: BOARD, problem: null, view, staleSince: null, clockAt: AT, ...over })

function DisplayDesign({ model }: { model: LineBoardModel }) {
  return createElement(WithMessages, { namespaces: ['line-board'] }, createElement(LineBoardView, { model }))
}

export const designScreen = defineDesignScreen<LineBoardModel>({
  screen: 'SCR-173',
  title: 'Line TV board (Floor)',
  view: DisplayDesign,
  cases: [
    { id: 'output', label: 'View 1 of 3: output today, a short hour with its reason code', model: board(0), note: 'Two huge numbers, hour bars, the target as a line. Never who.' },
    { id: 'stations', label: 'View 2 of 3: stations by colour, shape and word', model: board(1) },
    { id: 'wip', label: 'View 3 of 3: work in progress, DHU, the team leader’s note', model: board(2) },
    { id: 'no-note', label: 'No note today: the panel is hidden', model: board(2, { board: { ...BOARD, note: null } }) },
    { id: 'stale', label: 'Not updating for a minute: the amber band, the last figures stay', model: board(0, { staleSince: AT, problem: 'offline' }) },
    { id: 'no-target', label: 'A line without targets', model: board(0, { board: NO_TARGET_BOARD }) },
    { id: 'empty-day', label: 'No shift, no hours: output', model: board(0, { board: EMPTY_BOARD }) },
    { id: 'empty-stations', label: 'A line without stations', model: board(1, { board: EMPTY_BOARD }) },
    { id: 'empty-wip', label: 'Nothing waiting, no garment yet', model: board(2, { board: EMPTY_BOARD }) },
    { id: 'many-stations', label: 'Eighteen stations', model: board(1, { board: MANY_STATIONS_BOARD }) },
    { id: 'loading', label: 'Opening', model: board(0, { board: null }) },
    { id: 'offline', label: 'The first read failed: it keeps trying by itself', model: board(0, { board: null, problem: 'offline' }) },
    { id: 'no-line', label: 'Held: no line on this board', model: board(0, { board: null, problem: 'noLine' }) },
    { id: 'not-a-board', label: 'Held: this device is not a line board', model: board(0, { board: null, problem: 'notABoard' }) },
    { id: 'revoked', label: 'The device was revoked (it goes back to enrolment)', model: board(0, { board: null, problem: 'signedOut' }) },
  ],
})
