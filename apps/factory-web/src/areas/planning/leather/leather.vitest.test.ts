import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { designScreen, FIXTURES } from './fixtures'
import { designScreen as printScreen } from './print/fixtures'
import {
  acceptHeld,
  askNote,
  controlsOf,
  csvOfNeed,
  cutPlanRows,
  dismissHeld,
  draftPoHeld,
  leatherCan,
  NAMESPACE,
  neighbours,
  proposalWords,
  queryOf,
  reasonHeld,
  refusalOf,
  shadeOptions,
  splitWords,
  tileCounts,
  visibleNeed,
  visibleProtectors,
  visibleYield,
  type Words,
} from './model'
import { ApiError } from '../../../lib/api/errors'

/**
 * Planning › Leather & cut plan (SCR-252; B-W2b-132): the address, the tiles as saved filters (a count and its list agree),
 * what each option and decision needs and why it is held, the proposal and the options in words, the cut plan's rows, the
 * refusals in words, and every design case drawn in Italian and English with no key or placeholder left on screen.
 */

const words = (locale: 'it' | 'en' = 'en'): Words => {
  const messages = messagesFor(locale, [NAMESPACE, 'buying'])
  const units = createTranslator(locale, messages.buying!)
  return { t: createTranslator(locale, messages[NAMESPACE]!), unit: (uom) => units(`uom.${uom}`), locale }
}
const PLANNER = leatherCan(['planning.view', 'planning.run', 'planning.leather.manage', 'inventory.reserve', 'threads.post'])
const READER = leatherCan(['planning.view'])

describe('leather plan: the address and the tiles', () => {
  it('keeps site, tile, the one-shade filter, the search and the open drawer in the address', () => {
    const controls = controlsOf(new URLSearchParams('site=s1&tile=shade&feas=SPLIT&q=jkt&open=r1'))
    expect(controls).toEqual({ site: 's1', tile: 'shade', feas: 'SPLIT', q: 'jkt', open: 'r1' })
    expect(queryOf(controls)).toBe('site=s1&tile=shade&feas=SPLIT&q=jkt&open=r1')
    expect(controlsOf(new URLSearchParams('tile=nope&feas=NOPE'))).toMatchObject({ tile: null, feas: 'all' })
  })

  it('counts each tile as its filter lists it, and says unknown while a section is not read', () => {
    const counts = tileCounts(FIXTURES.NEED, FIXTURES.PROTECTORS, FIXTURES.YIELD)
    expect(counts).toEqual({ orders: 4, shade: 3, protectors: 2, drift: 2 })
    expect(new Set(visibleNeed(FIXTURES.NEED.rows, { tile: 'orders', feas: 'all', q: '' }).map((row) => row.order.id)).size).toBe(counts.orders)
    expect(visibleNeed(FIXTURES.NEED.rows, { tile: 'shade', feas: 'all', q: '' })).toHaveLength(counts.shade!)
    expect(visibleProtectors(FIXTURES.PROTECTORS.rows, { tile: 'protectors', q: '' })).toHaveLength(counts.protectors!)
    expect(visibleYield(FIXTURES.YIELD.rows, { tile: 'drift', q: '' })).toHaveLength(counts.drift!)
    expect(tileCounts(null, FIXTURES.PROTECTORS, null)).toEqual({ orders: null, shade: null, protectors: 2, drift: null })
    expect(visibleNeed(FIXTURES.NEED.rows, { tile: null, feas: 'all', q: 'pnt-demo' }).map((row) => row.style.code)).toEqual(['PNT-DEMO-03'])
  })

  it('opens the page and its print among the built pages; the reads open the page', () => {
    expect(OFFICE_PAGES.has('/planning/leather')).toBe(true)
    expect(OFFICE_PAGES.has('/planning/leather/print')).toBe(true)
    expect(LIST_PAGES['/planning/leather/need']).toBe('/planning/leather')
  })
})

describe('leather plan: options and decisions, held with the reason', () => {
  it('offers the options each answer has, held without the right', () => {
    expect(shadeOptions(FIXTURES.FITS, PLANNER).map((entry) => entry.option)).toEqual(['reserve'])
    expect(shadeOptions(FIXTURES.SPLIT, PLANNER)).toEqual([
      { option: 'split', held: null },
      { option: 'buy', held: 'held.noDraftPo' },
      { option: 'ask', held: null },
    ])
    expect(shadeOptions(FIXTURES.MUST_BUY, READER)).toEqual([
      { option: 'buy', held: 'held.noDraftPo' },
      { option: 'ask', held: 'held.noNote' },
    ])
    expect(shadeOptions(FIXTURES.COVERED, PLANNER)).toEqual([])
    expect(draftPoHeld({ ...FIXTURES.MUST_BUY, requirement: { ...FIXTURES.MUST_BUY.requirement, decision: 'ORDERED' } }, leatherCan(['purchasing.manage']))).toBe('held.requirement.ORDERED')
    expect(draftPoHeld(FIXTURES.FITS, leatherCan(['purchasing.manage']))).toBe('held.notMustBuy')
  })

  it('holds Accept and Dismiss in words', () => {
    expect(acceptHeld(FIXTURES.DRIFT, PLANNER)).toBeNull()
    expect(acceptHeld(FIXTURES.DRIFT, READER)).toBe('held.noManage')
    expect(acceptHeld(FIXTURES.IN_LINE, PLANNER)).toBe('held.noProposal')
    expect(acceptHeld({ ...FIXTURES.DRIFT, proposal: { ...FIXTURES.DRIFT.proposal, state: 'ACCEPTED' } }, PLANNER)).toBe('held.waitsForDraft')
    expect(acceptHeld({ ...FIXTURES.DRIFT_DRAFT, proposal: { ...FIXTURES.DRIFT_DRAFT.proposal, state: 'ACCEPTED' } }, PLANNER)).toBeNull()
    expect(dismissHeld({ ...FIXTURES.DRIFT, proposal: { ...FIXTURES.DRIFT.proposal, state: 'DISMISSED' } }, PLANNER)).toBe('held.dismissedAlready')
    expect(reasonHeld(' ok ')).toBe('held.reasonShort')
    expect(reasonHeld('A new die since week 46.')).toBeNull()
  })

  it('says the proposal, the split and the note for Sales in both languages', () => {
    expect(proposalWords(FIXTURES.DRIFT, words(), 5)).toBe('Set loss 12 % → 14 %')
    expect(proposalWords(FIXTURES.TOO_FEW, words(), 5)).toBe('3 cuts of 5 needed')
    expect(proposalWords(FIXTURES.DRIFT, words('it'), 5)).toBe('Imposta perdita 12 % → 14 %')
    expect(splitWords(FIXTURES.SPLIT, words())).toBe('sizes 46–50 from LOT-DEMO-221, sizes 52 from LOT-DEMO-230')
    const note = askNote(FIXTURES.ASK, words())
    expect(note).toContain(FIXTURES.ASK.order.number)
    expect(note).not.toMatch(/\{[a-z]+\}/)
  })

  it('says refusals in words', () => {
    const conflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path, message: 'x' }])
    expect(refusalOf(conflict('refusal/PROPOSAL_MOVED'))).toBe('refusal.moved')
    expect(refusalOf(conflict('refusal/ALREADY_ACCEPTED'))).toBe('refusal.alreadyAccepted')
    expect(refusalOf(conflict('body/lines/0/refusal/SHADE_LOT'))).toBe('refusal.shade')
    expect(refusalOf(new Error('boom'))).toBe('refusal.failed')
  })

  it('lays out the cut plan and the export, and walks the drawer', () => {
    const rows = cutPlanRows([FIXTURES.SPLIT], words())
    expect(rows[0]!.cells).toHaveLength(8)
    expect(rows[0]!.cells[6]).toBe('sizes 46–50 from LOT-DEMO-221, sizes 52 from LOT-DEMO-230')
    expect(csvOfNeed([FIXTURES.FITS], words()).split('\r\n')).toHaveLength(2)
    expect(neighbours(['a', 'b', 'c'], 'b')).toEqual({ prev: 'a', next: 'c' })
    expect(neighbours(['a'], 'a')).toEqual({ prev: null, next: null })
  })
})

const LEFT_KEY = /\b(?:page|live|noAccess|keys|held|row|col|tile|need|protectors|protector|yield|shade|option|accept|dismiss|bulk|error|empty|common|notice|refusal|lot|grade|feasibility|print|csv|note|ask)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Said on purpose: permission names in the held reasons. */
const SAID = /\b(?:planning\.(?:view|run|leather\.manage)|inventory\.reserve|purchasing\.manage|threads\.post)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [designScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }
})
