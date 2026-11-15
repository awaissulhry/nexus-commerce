import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as remindersScreen } from '../reminders/fixtures'
import { doneable, viewCount } from '../reminders/model'
import { tasksAddress } from '../model'
import { designScreen as boardScreen } from './fixtures'
import { TASK_MODES, taskLanes, taskModes, taskMoveHeld } from './modes'

/** My tasks' board and calendar, and Reminders (B-W2b-388; COL-041): rules, words, cases. */

const KEY_ON_SCREEN = /\b(reminders|remind|board|held|set)\.[a-zA-Z]/
const t = createTranslator('en', messagesFor('en', ['home-mywork'])['home-mywork'] ?? {})

describe('Board by status and Calendar by due date', () => {
  it('lanes are the statuses with their counts; a move needs no review only between Open and Done', () => {
    expect(TASK_MODES).toEqual(['table', 'board', 'calendar'])
    expect(taskLanes([{ status: 'OPEN' }, { status: 'OPEN' }, { status: 'DONE' }], t).map((lane) => [lane.id, lane.total])).toEqual([['OPEN', 2], ['DONE', 1], ['CANCELLED', 0]])
    const input = { t, held: null }
    expect(taskMoveHeld({ status: 'OPEN', canChange: true }, 'DONE', input)).toBeNull()
    expect(taskMoveHeld({ status: 'DONE', canChange: true }, 'OPEN', input)).toBeNull()
    expect(taskMoveHeld({ status: 'OPEN', canChange: true }, 'CANCELLED', input)).toBe(t('board.held.cancel'))
    expect(taskMoveHeld({ status: 'CANCELLED', canChange: true }, 'DONE', input)).toBe(t('board.held.reopenFirst'))
    expect(taskMoveHeld({ status: 'OPEN', canChange: false }, 'DONE', input)).toBe(t('board.held.readOnly'))
    expect(taskMoveHeld({ status: 'OPEN', canChange: true }, 'DONE', { t, held: 'Offline' })).toBe('Offline')
  })

  it('a move goes through Done or Reopen; the mode stays in the address', () => {
    const done: string[] = []
    const reopened: string[] = []
    const modes = taskModes([], { mode: 'board', onMode: () => undefined, t, held: null, onComplete: (id) => done.push(id), onReopen: (id) => reopened.push(id) })
    const row = (status: 'OPEN' | 'DONE') => ({ id: status, status, canChange: true }) as never
    expect(modes.board!.onMove!(row('OPEN'), 'DONE')).toBe(true)
    expect(modes.board!.onMove!(row('DONE'), 'OPEN')).toBe(true)
    expect(modes.board!.onMove!(row('OPEN'), 'CANCELLED')).toBe(false)
    expect([done, reopened]).toEqual([['OPEN'], ['DONE']])
    expect(tasksAddress({ scope: 'MINE', tile: null, q: '', open: null, mode: 'calendar' })).toBe('?mode=calendar')
    expect(tasksAddress({ scope: 'MINE', tile: null, q: '', open: null, mode: 'table' })).toBe('')
  })
})

describe('Reminders', () => {
  it('counts each list and finishes only what is not done', () => {
    const counts = { waiting: 3, cameBack: 2, done: 4 }
    expect([viewCount('OPEN', counts), viewCount('WAITING', counts), viewCount('CAME_BACK', counts), viewCount('DONE', counts)]).toEqual([5, 3, 2, 4])
    const rows = [{ id: 'a', state: 'WAITING' }, { id: 'b', state: 'DONE' }] as never[]
    expect(doneable(rows, ['a', 'b']).map((row: { id: string }) => row.id)).toEqual(['a'])
  })
})

describe('the cases', () => {
  it('draws every case of SCR-544 and SCR-545 with no key on screen, in it and en', () => {
    for (const screen of [remindersScreen, boardScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: item.model })))
          expect(html, `${screen.screen} ${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
        }
      }
    }
  })
})
