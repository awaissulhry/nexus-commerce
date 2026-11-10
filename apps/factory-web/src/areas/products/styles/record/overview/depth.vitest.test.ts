import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { demoStyle, ROWS } from '../../demo/fixtures'
import { designScreen as listScreen } from '../../list/depth/fixtures'
import { NO_GATE, seasonPlan, seasonProblem, seasonsInUse, unreadIds } from '../../list/depth/model'
import { demoAssign, demoGate, demoPrivateLabel, demoTexts, demoWhereUsed, depthModel } from './demo/fixtures'
import { designScreen } from './fixtures'
import {
  assignHeld,
  CODE_KEYS,
  completenessTone,
  confirmHeld,
  depthCan,
  depthProblem,
  fixTab,
  gtinText,
  languageRows,
  moveHeld,
  moveProblem,
  NO_ASSIGN,
  pctText,
  ready,
  refusalKey,
  sameText,
  soldHeld,
  stateKey,
  textDraftOf,
  textProblems,
  textsHeld,
  waitingForGtin,
  whereUsedHref,
} from './model'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LIST_DEPTH = fileURLToPath(new URL('../../list/depth/', import.meta.url))

describe('who may do what (B-W2b-237)', () => {
  it('reads the four permissions; a move, a text, the label and Assign GTINs say why they are held', () => {
    const owner = depthModel('owner')
    const sales = depthModel('sales')
    expect(depthCan(['product.styles.view', 'product.gtins.manage'])).toEqual({ view: true, manage: false, lifecycle: false, gtins: true })
    expect(moveHeld(owner)).toBeNull()
    expect(moveHeld(sales)).toBe('lifecycle.held.noRight')
    expect(moveHeld({ ...owner, archived: true })).toBe('lifecycle.held.archived')
    expect(moveHeld({ ...owner, online: false })).toBe('hold.offline')
    expect(textsHeld(sales, demoTexts())).toBe('hold.noManage')
    expect(textsHeld(owner, demoTexts({ refused: true }))).toBe('refusal.EDIT_BLOCKED')
    expect(assignHeld(owner, 0)).toBe('gtin.held.none')
    expect(assignHeld(sales, 3)).toBe('gtin.held.noRight')
    expect(assignHeld(owner, 3)).toBeNull()
  })

  it('a move back needs its reason; a long reason is held', () => {
    expect(moveProblem(true, '  ')).toBe('move.held.reason')
    expect(moveProblem(false, '')).toBeNull()
    expect(moveProblem(false, 'x'.repeat(501))).toBe('hold.long')
    expect(refusalKey('NEEDS_RELEASED_REVISION')).toBe('refusal.NEEDS_RELEASED_REVISION')
    expect(refusalKey('SOMETHING_NEW')).toBe('refusal.other')
  })
})

describe('names per language', () => {
  const texts = demoTexts()
  it('a new language: a BCP 47 tag not written yet, a one-line name within its limit', () => {
    expect(textProblems({ language: '', name: 'X', shortDescription: '', longDescription: '' }, texts, true).language).toBe('text.problem.languageEmpty')
    expect(textProblems({ language: 'deutsch schweiz', name: 'X', shortDescription: '', longDescription: '' }, texts, true).language).toBe('text.problem.languageTag')
    expect(textProblems({ language: 'FR', name: 'X', shortDescription: '', longDescription: '' }, texts, true).language).toBe('text.problem.languageTaken')
    expect(textProblems({ language: 'de-ch', name: 'X', shortDescription: '', longDescription: '' }, texts, true)).toEqual({})
    expect(textProblems({ language: 'es', name: ' ', shortDescription: 'a\tb', longDescription: 'p1\n\np2' }, texts, true)).toEqual({ name: 'text.problem.nameEmpty', shortDescription: 'text.problem.oneLine' })
    expect(textProblems({ language: 'es', name: 'x'.repeat(201), shortDescription: '', longDescription: '' }, texts, true).name).toBe('text.problem.long')
  })

  it('an unchanged row holds Save; the company language comes first, then the other rows, then W1 names not written', () => {
    expect(sameText(textDraftOf(texts, 'de'), texts)).toBe(true)
    expect(sameText({ ...textDraftOf(texts, 'de'), name: 'Andere Jacke' }, texts)).toBe(false)
    expect(languageRows(texts).map((row) => [row.language, row.row !== null])).toEqual([
      ['it', true],
      ['de', true],
      ['fr', true],
      ['en', false],
    ])
  })
})

describe('the private label', () => {
  it('Sold under our name is held for our own collection (the brand is chosen in Identity)', () => {
    const owner = depthModel('owner')
    expect(soldHeld(owner, demoPrivateLabel())).toBe('label.held.noBrand')
    expect(soldHeld(owner, demoPrivateLabel({ brand: true }))).toBeNull()
    expect(soldHeld(depthModel('sales'), demoPrivateLabel({ brand: true }))).toBe('hold.noManage')
  })
})

describe('completeness and where-used', () => {
  it('the meter tone follows what is open, never the percentage; the percentage in the person’s language', () => {
    expect(completenessTone(demoGate())).toBe('missing')
    expect(completenessTone({ ...demoGate(), blockers: 0 })).toBe('partial')
    expect(completenessTone(demoGate({ ready: true }))).toBe('complete')
    expect(completenessTone({ ...demoGate(), completenessPct: null })).toBe('unknown')
    expect(pctText('87.5', 'it')).toBe('87,5 %')
    expect(pctText('87.5', 'en')).toBe('87.5 %')
    expect(pctText(null, 'en')).toBe('—')
    expect(fixTab('minutes')).toBe('routing')
    expect(fixTab('measurements')).toBe('sizes')
    expect(fixTab('unknown')).toBe('overview')
  })

  it('each row opens its record (the own page when built, else its panels); stock rows are SKUs: no link; unknown states said open or closed', () => {
    const view = demoWhereUsed()
    const quote = view.groups.find((group) => group.kind === 'QUOTES')!.rows[0]!
    const stock = view.groups.find((group) => group.kind === 'STOCK')!.rows[0]!
    expect(whereUsedHref('/w/DEMO', 'QUOTES', quote, OFFICE_PAGES)).toBe(`/w/DEMO/sales/quotes/${quote.id}`)
    expect(whereUsedHref('/w/DEMO', 'STOCK', stock, OFFICE_PAGES)).toBeNull()
    expect(stateKey('SENT', true)).toBe('whereUsed.state.SENT')
    expect(stateKey('SOMETHING', false)).toBe('whereUsed.state.otherClosed')
  })
})

describe('GTINs', () => {
  const style = demoStyle()
  it('Assign gives numbers to the SKUs switched on without a GTIN; the confirm waits for the preview, the GS1 gate and something to give', () => {
    expect(waitingForGtin(style.skus)).toBe(style.skus.filter((sku) => sku.status === 'ACTIVE' && !sku.gtin).length)
    expect(confirmHeld(NO_ASSIGN, false)).toBe('gtin.held.preview')
    expect(confirmHeld({ ...NO_ASSIGN, preview: ready(demoAssign(style, { closed: true })) }, false)).toBe('gtin.held.gate')
    expect(confirmHeld({ ...NO_ASSIGN, preview: ready(demoAssign(style)) }, false)).toBeNull()
    expect(confirmHeld({ ...NO_ASSIGN, preview: ready(demoAssign(style)) }, true)).toBe('hold.busy')
    expect(gtinText('2009999001201')).toBe('2 009999 001201')
  })

  it('the made-up preview never gives a number twice and passes over the one on a SKU', () => {
    const preview = demoAssign(style)
    const gtins = preview.assignments.map((row) => row.gtin)
    expect(new Set(gtins).size).toBe(gtins.length)
    expect(gtins).not.toContain(preview.skipped[0]!.gtin)
  })
})

describe('a refused write in our words', () => {
  const error = (status: number, code: string, issues: Array<{ path: string; message: string }> = []) => new ApiError(status === 409 ? 'conflict' : status === 400 ? 'invalid' : 'forbidden', status, code, 'x', null, issues)
  it('the API’s refusal codes, a version conflict, the assign’s "preview again", the private label’s 400', () => {
    expect(depthProblem(error(409, 'conflict', [{ path: 'refusal/NEEDS_NEW_REVISION', message: 'x' }]), 'text')).toEqual({ key: 'refusal.NEEDS_NEW_REVISION', reload: true })
    expect(depthProblem(error(409, 'version_conflict', [{ path: 'version', message: 'x' }]), 'move').key).toBe('fault.moved')
    expect(depthProblem(error(409, 'conflict'), 'assign').key).toBe('gtin.problem.again')
    expect(depthProblem(error(400, 'validation_failed', [{ path: 'body/soldUnderOurName', message: 'x' }]), 'label').key).toBe('label.held.noBrand')
    expect(depthProblem(error(403, 'forbidden'), 'read').key).toBe('fault.read.forbidden')
    expect(depthProblem(new Error('x'), 'move').key).toBe('fault.internal')
  })
})

describe('Set season (the list)', () => {
  it('archived styles are left out, the ones in that season already are not sent; empty clears; at most 20 characters', () => {
    const rows = ROWS.filter((row) => ['DEMO-JKT-03', 'DEMO-JKT-90', 'DEMO-VST-01', 'DEMO-JKT-01'].includes(row.code))
    const plan = seasonPlan(rows, ' SS28 ')
    expect(plan.change.map((row) => row.code)).toEqual(['DEMO-JKT-01'])
    expect(plan.same.map((row) => row.code).sort()).toEqual(['DEMO-JKT-03', 'DEMO-VST-01'])
    expect(plan.archived.map((row) => row.code)).toEqual(['DEMO-JKT-90'])
    expect(seasonPlan(rows, '').change.map((row) => row.code).sort()).toEqual(['DEMO-JKT-01', 'DEMO-JKT-03', 'DEMO-VST-01'])
    expect(seasonProblem('x'.repeat(21))).toBe('season.problem.long')
    expect(seasonProblem('SS28')).toBeNull()
    expect(seasonsInUse(ROWS).slice(0, 2)).toEqual(['FW27', 'SS28'])
    expect(unreadIds(ROWS.slice(0, 2), { ...NO_GATE, byStyle: { [ROWS[0]!.id]: demoGate() } })).toEqual([ROWS[1]!.id])
  })
})

// ---- words ------------------------------------------------------------------------------------------------------------------

const PREFIXES = ['base', 'hold', 'fault', 'refusal', 'lifecycle', 'move', 'replacement', 'type', 'attr', 'names', 'text', 'label', 'score', 'whereUsed', 'cells', 'gtin', 'column', 'season']
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx)$/.test(entry.name) && !/(vitest|fixtures|demo)/.test(entry.name) ? [join(dir, entry.name)] : []))
const literalKeys = (): string[] => [
  ...new Set(
    [...sources(HERE), ...sources(LIST_DEPTH)].flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]+)'/g), ...text.matchAll(new RegExp(`'((?:${PREFIXES.join('|')})\\.[a-zA-Z][\\w.]+)'`, 'g'))].map((match) => match[1]!)
    }),
  ),
]
// The list's own words in StylesListView (td): its column and the bulk action.
const LIST_KEYS = ['column.release.column', 'season.bulk', 'season.held.allArchived']

describe('every key the depth names exists in it and en', () => {
  for (const locale of LOCALES) {
    it(`products-styles-depth (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.['products-styles-depth'] ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      const permissions = /^product\.(styles|gtins)\./
      const keys = [...literalKeys(), ...CODE_KEYS, ...LIST_KEYS].filter((key) => !permissions.test(key) && !/^style\./.test(key))
      expect(keys.length).toBeGreaterThan(250)
      expect(keys.filter((key) => !has(key))).toEqual([])
    })
  }
})

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [designScreen, listScreen] as Array<DesignScreen<unknown>>) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          // Permission names (product.styles.manage) and addresses are words, not keys.
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/(?:href|src)="[^"]*"/g, '')
            .replace(/\b(?:product|compliance|quality|inventory|parties|money|files)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})

describe('no money anywhere in the depth', () => {
  it('no case draws a currency', () => {
    for (const item of designScreen.cases) expect(render(designScreen as DesignScreen<unknown>, item.model, 'en'), item.id).not.toMatch(/€|EUR\b/)
  })
})
