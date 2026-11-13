import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { pickersOf, pickTakesProblem, takesChangeProblem } from '@nexus/factory-domain/product/options/takes'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as entryScreen } from '../../../sales/_shared/options-entry/fixtures'
import { entryButton, entryHeld } from '../../../sales/_shared/options-entry/model'
import { FOLLOWUPS_NS } from '../../../../lib/options-followups/words'
import { DEMO_STYLE } from '../../../sales/quotes/record/configurator/fixtures'
import { designScreen as takesScreen } from './fixtures'
import { takesHeld } from './model'

const VIEW = { groupId: 'g', code: 'DEMO-PANELS', version: 4, takes: null, picking: { colours: 2, materials: 0 }, may: { change: true, held: null } } as const

describe('what a chosen value takes (XF3:05)', () => {
  it('offers the picker the group takes, both when it takes either', () => {
    expect(pickersOf(null)).toEqual({ colour: true, material: true })
    expect(pickersOf('COLOUR')).toEqual({ colour: true, material: false })
    expect(pickersOf('MATERIAL')).toEqual({ colour: false, material: true })
  })
  it('a pick of the other kind is refused in words, as the database would', () => {
    expect(pickTakesProblem({ code: 'P', takes: 'COLOUR' }, { itemId: 'x' })?.en).toMatch(/takes a colour of the library/)
    expect(pickTakesProblem({ code: 'P', takes: 'MATERIAL' }, { colourId: 'x' })?.en).toMatch(/takes a material/)
    expect(pickTakesProblem({ code: 'P', takes: null }, { colourId: 'x', itemId: null })).toBeNull()
    expect(takesChangeProblem('P', 'MATERIAL', { colours: 2, materials: 0 })?.it).toMatch(/2 opzioni scelte/)
    expect(takesChangeProblem('P', 'COLOUR', { colours: 2, materials: 0 })).toBeNull()
  })
  it('Save waits: the API\'s words, offline, unchanged, saving, chosen options of the other kind', () => {
    const base = { view: { ...VIEW, picking: { ...VIEW.picking } , may: { ...VIEW.may } }, draft: 'COLOUR' as const, online: true, saving: false }
    expect(takesHeld({ ...base, view: { ...base.view, may: { change: false, held: { it: 'x', en: 'y' } } } })).toEqual({ words: { it: 'x', en: 'y' } })
    expect(takesHeld({ ...base, online: false })).toEqual({ key: 'takes.held.offline' })
    expect(takesHeld({ ...base, saving: true })).toEqual({ key: 'takes.held.busy' })
    expect(takesHeld({ ...base, draft: null })).toEqual({ key: 'takes.held.unchanged' })
    expect(takesHeld({ ...base, draft: 'MATERIAL' })).toEqual({ key: 'takes.held.colours', params: { count: 2 } })
    expect(takesHeld(base)).toBeNull()
  })
})

describe("a typed line's options (XF3:02)", () => {
  it('the button counts the options; Use waits for a text, the check, a refused combination', () => {
    expect(entryButton([])).toEqual({ key: 'entry.button' })
    expect(entryButton([{ valueId: 'a' }, { valueId: 'b' }])).toEqual({ key: 'entry.buttonCount', params: { count: 2 } })
    const name = DEMO_STYLE.groups[2]!
    const pick = { valueId: name.values[0]!.id, groupId: name.groupId, text: '', byDefault: false, colourId: null, itemId: null, itemColourId: null }
    const ok = { online: true, checking: false, check: { ok: true } as never, failed: false }
    expect(entryHeld(ok, [pick], DEMO_STYLE)).toEqual({ key: 'entry.held.text' })
    expect(entryHeld({ ...ok, check: null }, [{ ...pick, text: 'BIANCHI' }], DEMO_STYLE)).toEqual({ key: 'entry.held.checking' })
    expect(entryHeld({ ...ok, check: { ok: false } as never }, [{ ...pick, text: 'BIANCHI' }], DEMO_STYLE)).toEqual({ key: 'entry.held.refused' })
    expect(entryHeld({ ...ok, online: false }, [{ ...pick, text: 'BIANCHI' }], DEMO_STYLE)).toEqual({ key: 'entry.held.offline' })
    expect(entryHeld(ok, [{ ...pick, text: 'BIANCHI' }], DEMO_STYLE)).toBeNull()
  })
})

// ---- the words -----------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOTS = ['.', '../../../sales/_shared/options-entry', '../../../../portal/customer/orders/options'].map((path) => join(HERE, path))
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(entry) && !/vitest/.test(entry) ? [path] : []
  })
}
const PREFIXES = /^(common|takes|entry|share|portal|pasteOptions)\./

describe('every word of the options follow-ups is in both languages', () => {
  it('each literal key the code says is in the catalogue', () => {
    const missing: string[] = []
    for (const file of ROOTS.flatMap(sources)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'([a-z]+\.[A-Za-z0-9_.]+)'/g)) {
        const key = match[1]!
        if (!PREFIXES.test(key)) continue
        for (const locale of LOCALES) if (CATALOGUE[locale][FOLLOWUPS_NS]?.[key] === undefined) missing.push(`${locale} ${key} (${file.split('/').slice(-2).join('/')})`)
      }
    }
    expect(missing).toEqual([])
  })
})

// ---- the design cases ----------------------------------------------------------------------------------------------------

const LEFT_KEY = /\b(?:common|takes|entry|share|portal|pasteOptions)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [takesScreen, entryScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
  it('uses the next free screen ids: SCR-432 (what a value takes) and SCR-433 (a typed line\'s options)', () => {
    expect([takesScreen.screen, entryScreen.screen]).toEqual(['SCR-432', 'SCR-433'])
  })
})
