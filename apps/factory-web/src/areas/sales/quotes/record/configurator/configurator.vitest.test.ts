import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CONFIGURATOR_LINE_CODES } from '@nexus/factory-domain/sales/configurator/rules'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen as benchScreen } from '../../../../products/options/upkeep/fixtures'
import { SALES_CHECK_CODES } from '../lines-depth/model'
import { DEMO_LINE, designScreen as lineScreen } from './fixtures'
import { artworkRefusal, CONFIGURATOR_NS, draftChanged, draftOf, orderChange, picksBody, priceSummary, saveHeld, setPick, surchargeWords, togglePick, type SaveState } from './model'

const groups = DEMO_LINE.groups
const [liner, perf, name, armour] = groups

describe('the draft of the picks (SAL-139)', () => {
  it('one value of a SINGLE group in place of its other; a second click leaves it out; a MULTI keeps both', () => {
    let draft = draftOf(DEMO_LINE.chosen)
    draft = togglePick(draft, perf!, perf!.values[1]!.id)
    expect(draft.filter((pick) => pick.groupId === perf!.groupId).map((pick) => pick.valueId)).toEqual([perf!.values[1]!.id])
    draft = togglePick(draft, perf!, perf!.values[1]!.id)
    expect(draft.some((pick) => pick.groupId === perf!.groupId)).toBe(false)
    const multi = { ...perf!, kind: 'MULTI' as const, maxPicks: null }
    expect(togglePick(togglePick([], multi, perf!.values[0]!.id), multi, perf!.values[1]!.id)).toHaveLength(2)
  })
  it('a colour of the library or a leather article and its colour, never both', () => {
    let draft = setPick(draftOf(DEMO_LINE.chosen), perf!.values[0]!.id, { itemId: 'leather', itemColourId: null })
    const front = draft.find((pick) => pick.valueId === perf!.values[0]!.id)!
    expect(front).toMatchObject({ colourId: null, itemId: 'leather', itemColourId: null })
    draft = setPick(draft, perf!.values[0]!.id, { itemId: 'leather', itemColourId: 'red' })
    expect(draft.find((pick) => pick.valueId === perf!.values[0]!.id)).toMatchObject({ itemId: 'leather', itemColourId: 'red' })
    draft = setPick(draft, perf!.values[0]!.id, { colourId: 'fluo' })
    expect(draft.find((pick) => pick.valueId === perf!.values[0]!.id)).toMatchObject({ colourId: 'fluo', itemId: null, itemColourId: null })
  })
  it('the body leaves the defaults out (the API takes them again) and sends a text only where the value takes one', () => {
    const body = picksBody(draftOf(DEMO_LINE.chosen), groups)
    expect(body.map((pick) => pick.valueId)).toEqual([liner!.values[0]!.id, perf!.values[0]!.id, name!.values[0]!.id])
    expect(body.find((pick) => pick.valueId === name!.values[0]!.id)).toEqual({ valueId: name!.values[0]!.id, text: 'ROSSI' })
    expect(body.find((pick) => pick.valueId === perf!.values[0]!.id)?.colourId).toBe('55555555-0000-4000-8000-000000000002')
    expect(body.some((pick) => pick.valueId === armour!.values[0]!.id)).toBe(false)
    expect(draftChanged(draftOf(DEMO_LINE.chosen), DEMO_LINE.chosen, groups)).toBe(false)
    expect(draftChanged(setPick(draftOf(DEMO_LINE.chosen), name!.values[0]!.id, { text: 'BIANCHI' }), DEMO_LINE.chosen, groups)).toBe(true)
  })
})

describe('surcharges in the options area\'s words (CF1:02)', () => {
  it('an amount with its currency, a percent, nothing for none', () => {
    expect(surchargeWords(liner!.values[0]!, 'en')).toMatch(/^\+60(\.00)? EUR$/)
    expect(surchargeWords(perf!.values[0]!, 'en')).toBe('+5 %')
    expect(surchargeWords(armour!.values[0]!, 'en')).toBeNull()
  })
})

describe('Save waits with its reason; the price is the API\'s', () => {
  const base: SaveState = { held: null, changed: true, checking: false, preview: null, saving: false, offline: false, keepPrice: false, kind: 'QUOTE' }
  const ok = { ok: true, blocks: [], warnings: [], outsideCertificate: false, certificateNotes: [], chosen: [], pricing: { repriced: true, held: null, manualKept: false, unitPrice: '413', before: '470', optionsTotal: '35', change: null, steps: null, marginPct: '25', marginBefore: '34' }, problem: null }
  const draft = draftOf(DEMO_LINE.chosen)
  it('in this order: the API\'s held words, offline, unchanged, a text, the check, a block, an order\'s price change', () => {
    expect(saveHeld({ ...base, held: { it: 'x', en: 'held' } }, draft, groups)).toEqual({ words: { it: 'x', en: 'held' } })
    expect(saveHeld({ ...base, offline: true }, draft, groups)).toEqual({ key: 'save.held.offline' })
    expect(saveHeld({ ...base, changed: false }, draft, groups)).toEqual({ key: 'save.held.unchanged' })
    expect(saveHeld(base, setPick(draft, name!.values[0]!.id, { text: '' }), groups)).toEqual({ key: 'groups.textMissing' })
    expect(saveHeld(base, draft, groups)).toEqual({ key: 'save.held.checking' })
    expect(saveHeld({ ...base, preview: { ...ok, ok: false } }, draft, groups)).toEqual({ key: 'save.held.blocked' })
    expect(saveHeld({ ...base, preview: ok }, draft, groups)).toBeNull()
    const order = { ...ok, pricing: { ...ok.pricing, repriced: false, change: '25' } }
    expect(orderChange(order)).toBe('25')
    expect(saveHeld({ ...base, kind: 'ORDER', preview: order }, draft, groups)).toEqual({ key: 'save.held.keepPrice' })
    expect(saveHeld({ ...base, kind: 'ORDER', preview: order, keepPrice: true }, draft, groups)).toBeNull()
  })
  it('the price shown is the saved line, then the API\'s plan of the draft', () => {
    expect(priceSummary(DEMO_LINE, null)).toMatchObject({ before: '470', after: '470', optionsTotal: '95', marginBefore: '34.04', manualKept: true, notHeld: false })
    expect(priceSummary(DEMO_LINE, ok)).toMatchObject({ before: '470', after: '413', optionsTotal: '35', marginAfter: '25' })
  })
  it('artwork is a PDF or a picture of at most 25 MB', () => {
    expect(artworkRefusal({ type: 'application/pdf', size: 1000 })).toBeNull()
    expect(artworkRefusal({ type: 'image/svg+xml', size: 1000 })).toEqual({ key: 'artwork.problem.type' })
    expect(artworkRefusal({ type: 'image/png', size: 26 * 1024 * 1024 })).toEqual({ key: 'artwork.problem.size' })
  })
  it("the line rule's codes have the send dialog's words and the Warnings section's", () => {
    for (const code of CONFIGURATOR_LINE_CODES) {
      expect(SALES_CHECK_CODES).toContain(code)
      for (const locale of LOCALES) expect(CATALOGUE[locale].sales?.[`check.${code}`], `${locale} check.${code}`).toBeTruthy()
    }
  })
})

// ---- the words ---------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOTS = ['.', '../../../orders/record/configurator', '../../../../products/options/upkeep'].map((path) => join(HERE, path))
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(entry) && !/fixtures|vitest/.test(entry) ? [path] : []
  })
}
const PREFIXES = /^(section|common|picture|price|groups|check|artwork|save|problem|order|bench)\./

describe('every word of the configurator is in both languages', () => {
  it('each literal key the code says is in the catalogue', () => {
    const missing: string[] = []
    for (const file of ROOTS.flatMap(sources)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'([a-z]+\.[A-Za-z0-9_.]+)'/g)) {
        const key = match[1]!
        if (!PREFIXES.test(key)) continue
        for (const locale of LOCALES) if (CATALOGUE[locale][CONFIGURATOR_NS]?.[key] === undefined) missing.push(`${locale} ${key} (${file.split('/').slice(-2).join('/')})`)
      }
    }
    for (const held of ['NO_START', 'NOT_SIZE_GRID', 'FEE']) for (const locale of LOCALES) if (CATALOGUE[locale][CONFIGURATOR_NS]?.[`price.held.${held}`] === undefined) missing.push(`${locale} price.held.${held}`)
    expect(missing).toEqual([])
  })
})

// ---- the design cases ----------------------------------------------------------------------------------------------------

const LEFT_KEY = /\b(?:section|picture|price|groups|artwork|save|problem|order|bench)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [lineScreen, benchScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/\/api\/[^"\s<]+/g, '').replace(/[\w.-]+\.(pdf|png)\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
  it('uses the screen ids the lead gave: SCR-425 (the line) and SCR-426 (the bench)', () => {
    expect([lineScreen.screen, benchScreen.screen]).toEqual(['SCR-425', 'SCR-426'])
  })
})
