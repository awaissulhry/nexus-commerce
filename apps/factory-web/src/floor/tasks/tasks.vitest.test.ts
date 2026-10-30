import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { homeTiles } from '../model'
import { readScan } from '../scan/scan-model'
import { FLOOR_NAMESPACES, taskForScan, taskOfTile, TASK_ROUTES } from './routes'
import { refusalsOf, taskProblemOf } from './shared/task-api'
import { ApiError } from '../../lib/api/errors'
import { queuedView } from './shared/queued'
import { AsOfMemory, codeKey } from './shared/as-of'
import { steppedUp } from './shared/step-up'

/**
 * The floor tasks (SCR-090, 093, 094, 095, 097): the scan router of Home, the shared helpers, and every design case of
 * every task drawing in both languages with no key left on screen, no secret, and no money (the floor shows none).
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4211 })
const BUNDLE = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 123 })
const ALL = ['floor.work', 'production.scan', 'production.cut', 'production.bundles', 'inventory.issue', 'quality.inspections.view']

describe('Home\'s scan router: the job for this station, with the label loaded', () => {
  it('a bundle at a sewing station opens Operation; a hide at a cutting table opens Cut, a bundle there Bundles', () => {
    expect(taskForScan('sewing', readScan(BUNDLE, TAG), homeTiles('sewing', ALL, false))).toBe('operation')
    expect(taskForScan('cutting', readScan(HIDE, TAG), homeTiles('cutting', ALL, false))).toBe('cut')
    expect(taskForScan('cutting', readScan(BUNDLE, TAG), homeTiles('cutting', ALL, false))).toBe('bundles')
    expect(taskForScan('sewing', readScan(HIDE, TAG), homeTiles('sewing', ALL, false))).toBeNull()
    expect(taskForScan('packing', readScan(BUNDLE, TAG), homeTiles('packing', ALL, false))).toBe('operation')
    expect(taskForScan('inspection', readScan(BUNDLE, TAG), homeTiles('inspection', ALL, false))).toBe('operation')
  })

  it('at a packing station a garment\'s serial or a pack slip opens the packing bench; a bundle still opens Operation', () => {
    const SERIAL = formatScanId({ type: 'SERIAL', tenantTag: TAG, ref: 77 })
    const PACKER = [...ALL, 'shipping.pack']
    expect(taskForScan('packing', readScan(SERIAL, TAG), homeTiles('packing', PACKER, false))).toBe('pack')
    expect(taskForScan('packing', readScan('SH-0012', TAG), homeTiles('packing', PACKER, false))).toBe('pack')
    expect(taskForScan('packing', readScan(BUNDLE, TAG), homeTiles('packing', PACKER, false))).toBe('operation')
    expect(taskForScan('packing', readScan(HIDE, TAG), homeTiles('packing', PACKER, false))).toBeNull()
    // Without the Pack tile (no shipping.pack): Scan anything.
    expect(taskForScan('packing', readScan(SERIAL, TAG), homeTiles('packing', ALL, false))).toBeNull()
    expect(taskOfTile('pack')).toBe('pack')
  })

  it('a work order number opens Pick & issue at the warehouse and Final inspection at the bench', () => {
    expect(taskForScan('warehouse', readScan('WO-0042', TAG), homeTiles('warehouse', ALL, false))).toBe('pick')
    expect(taskForScan('inspection', readScan('WO-0042', TAG), homeTiles('inspection', ALL, false))).toBe('final')
  })

  it('never opens a task the person has no open tile for (fail closed, held by the notice)', () => {
    expect(taskForScan('sewing', readScan(BUNDLE, TAG), homeTiles('sewing', ['floor.work'], false))).toBeNull()
    expect(taskForScan('sewing', readScan(BUNDLE, TAG), homeTiles('sewing', ALL, true))).toBeNull()
    expect(taskForScan(null, readScan(BUNDLE, TAG), homeTiles(null, ALL, false))).toBeNull()
  })

  it('maps each task tile to its page', () => {
    expect(taskOfTile('operation')).toBe('operation')
    expect(taskOfTile('scan')).toBeNull()
    expect(taskOfTile('receive')).toBe('receive')
    expect(taskOfTile('labels')).toBe('labels')
    expect(Object.values(TASK_ROUTES).every((path) => path.startsWith('/floor/'))).toBe(true)
  })
})

describe('the shared helpers', () => {
  it('reads a rule\'s refusal with its fix from the API\'s issues', () => {
    const error = new ApiError('conflict', 409, 'conflict', 'x', null, [
      { path: 'refusal/ALREADY_REPORTED', message: 'Already reported.' },
      { path: 'fix', message: 'Undo is on Home.' },
    ])
    expect(taskProblemOf(error)).toEqual({ kind: 'refused', code: 'ALREADY_REPORTED', message: 'Already reported.', fix: 'Undo is on Home.' })
    const checks = new ApiError('conflict', 409, 'conflict', 'x', null, [
      { path: 'checks/LABELS', message: 'Labels missing.' },
      { path: 'checks/LABELS/fix', message: 'Print them.' },
      { path: 'checks/SECOND_PERSON', message: 'Another inspector.' },
    ])
    expect(refusalsOf(checks)).toEqual([
      { code: 'LABELS', message: 'Labels missing.', fix: 'Print them.' },
      { code: 'SECOND_PERSON', message: 'Another inspector.', fix: null },
    ])
    expect(taskProblemOf(new ApiError('step_up', 403, 'forbidden', 'x', null, [{ path: 'stepUp' }]))).toEqual({ kind: 'stepUp' })
    expect(taskProblemOf(new ApiError('unavailable', 0, 'network', 'x'))).toEqual({ kind: 'offline' })
    expect(taskProblemOf(new Error('x'))).toEqual({ kind: 'unavailable' })
  })

  it('shows an action\'s two ticks from the queue', () => {
    const item = { clientEventId: 'e1', state: 'waiting', refusal: null } as never
    expect(queuedView({ items: [item], online: false, sending: false }, 'e1')?.ticks).toBe('saved')
    expect(queuedView({ items: [item], online: true, sending: true }, 'e1')?.ticks).toBe('sending')
    expect(queuedView({ items: [{ ...(item as object), state: 'recorded' } as never], online: true, sending: false }, 'e1')?.ticks).toBe('recorded')
    expect(queuedView({ items: [], online: true, sending: false }, 'e1')).toBeNull()
  })

  it('remembers what the tablet read, with its time, and forgets the oldest', () => {
    const memory = new AsOfMemory<number>(2)
    memory.keep(codeKey(' bn-1 '), 1, new Date('2026-10-29T08:00:00Z'))
    memory.keep('B', 2)
    memory.keep('C', 3)
    expect(memory.get('BN-1')).toBeNull()
    expect(memory.get('C')?.value).toBe(3)
  })

  it('knows a fresh PIN window, never a stale one', () => {
    const now = new Date('2026-10-29T08:00:00Z')
    expect(steppedUp('2026-10-29T08:01:00Z', now)).toBe(true)
    expect(steppedUp('2026-10-29T08:00:02Z', now)).toBe(false)
    expect(steppedUp(null, now)).toBe(false)
  })
})

// ---- every task's design cases ------------------------------------------------------------------------------------------

const FOUND = import.meta.glob('./*/fixtures.ts', { eager: true, import: 'designScreen' }) as Record<string, DesignScreen<unknown> | undefined>
const SCREENS = Object.values(FOUND).filter((screen): screen is DesignScreen<unknown> => Boolean(screen))

// A key left on screen: a path of one of the floor catalogues' top-level names ("card.title", "problem.offline.body").
const TOP = [...new Set(FLOOR_NAMESPACES.flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {}).map((key) => key.split('.')[0]!)))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model })))
}

describe('every floor task design case draws in both languages', () => {
  it('every catalogue of the floor exists in it and en with the same keys', () => {
    for (const namespace of FLOOR_NAMESPACES) {
      const it = Object.keys(CATALOGUE.it[namespace] ?? {}).sort()
      const en = Object.keys(CATALOGUE.en[namespace] ?? {}).sort()
      expect(it.length, namespace).toBeGreaterThan(0)
      expect(it, namespace).toEqual(en)
    }
  })

  for (const screen of SCREENS) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases, no key left, no secret, no money`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          const text = html.replace(/<[^>]+>/g, ' ')
          expect(text.match(/(?<![-\w])\d{6}(?![-\w])|\b[0-9A-HJKMNP-TV-Z]{26}\b/)?.[0] ?? null, `${screen.screen}/${item.id}`).toBeNull()
          expect(text.match(/€|EUR\s?\d|\$\s?\d/)?.[0] ?? null, `${screen.screen}/${item.id}: money on the floor`).toBeNull()
        }
      })
    }
  }
})
