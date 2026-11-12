import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { SAMPLE_LINE_KINDS, SAMPLE_ORDER_REFUSALS } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { CHOICES, IDS, SOURCING_ROLES_DEMO, TODAY } from './_demo/fixtures'
import { designScreen } from './fixtures'
import {
  addressOf,
  addressText,
  bodyOf,
  createHeld,
  defaultUnit,
  EMPTY_ADDRESS,
  emptyDraft,
  isOrdersChange,
  materialOf,
  materialsFor,
  newLine,
  problemOf,
  quantityOf,
  readProblemOf,
  sourcingCan,
  withAddress,
  withDefaults,
  withMaterial,
  withStyle,
  withWhat,
  type SampleDraft,
} from './model'

const params = (text: string) => new URLSearchParams(text)
const can = sourcingCan(SOURCING_ROLES_DEMO.buyer)

describe('RFQs & sourcing: the address and who may do what', () => {
  it('keeps the rows, the status, the words and New sample order in the address', () => {
    const address = addressOf(params('rows=all&status=SENT&q=giacca&new=1'))
    expect(address).toEqual({ rows: 'ALL', status: 'SENT', q: 'giacca', add: true })
    expect(addressOf(params(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(params('rows=x&status=NOPE'))).toEqual(EMPTY_ADDRESS)
    expect(addressText(EMPTY_ADDRESS)).toBe('')
    expect(withAddress(address, { add: false }).add).toBe(false)
  })

  it('the buyer drafts and sees the cost; the planner reads without it; sales reads nothing', () => {
    expect(can).toEqual({ view: true, manage: true, cost: true })
    expect(sourcingCan(SOURCING_ROLES_DEMO.planner)).toEqual({ view: true, manage: false, cost: false })
    expect(sourcingCan(SOURCING_ROLES_DEMO.sales).view).toBe(false)
  })

  it('reads every purchase-order event as a change of the list', () => {
    expect(isOrdersChange({ type: 'purchase_order.sent' })).toBe(true)
    expect(isOrdersChange({ type: 'claim.changed' })).toBe(false)
  })

  it('is in the navigation and the built pages; its API list opens it', () => {
    expect(OFFICE_PAGES.has('/purchasing/sourcing')).toBe(true)
    expect(LIST_PAGES['/purchasing/sample-orders']).toBe('/purchasing/sourcing')
    const items = officeNavFor(permissionCheck([...SOURCING_ROLES_DEMO.buyer])).areas.find((area) => area.id === 'purchasing')!.sections!.flatMap((section) => section.items.map((item) => item.href))
    expect(items.indexOf('/purchasing/sourcing')).toBe(items.indexOf('/purchasing/claims') - 1)
  })
})

describe('New sample order: the draft and why Create draft is held', () => {
  const leather = materialOf(CHOICES, IDS.leather)!
  const mesh = materialOf(CHOICES, IDS.mesh)!

  it('a hide starts in hides; another line in the purchase unit; a hide takes only a leather', () => {
    expect(defaultUnit('HIDE', leather)).toBe('HIDE')
    expect(defaultUnit('COLOUR_CARD', leather)).toBe('FT2')
    expect(defaultUnit('SWATCH', materialOf(CHOICES, IDS.lining)!)).toBe('M')
    expect(defaultUnit('SWATCH', mesh)).toBe('M')
    expect(materialsFor(CHOICES, 'HIDE').map((item) => item.kind)).toEqual(['LEATHER'])
    expect(materialsFor(CHOICES, 'SWATCH')).toHaveLength(3)
    const line = withMaterial(newLine(TODAY, 'SWATCH'), mesh)
    expect(line).toMatchObject({ itemId: IDS.mesh, uom: 'M', itemColourId: mesh.colours[0]!.id })
    // A swatch of a textile turned into a hide loses its material.
    expect(withWhat(line, 'HIDE', CHOICES)).toMatchObject({ what: 'HIDE', itemId: null, uom: null })
    expect(withWhat(withMaterial(newLine(TODAY, 'SWATCH'), leather), 'HIDE', CHOICES)).toMatchObject({ itemId: IDS.leather })
    // The unit kept when the new material has it.
    expect(withMaterial({ ...line, uom: 'CM' }, leather).uom).toBe('FT2')
  })

  it('quantities as typed, with a comma or a point', () => {
    expect(quantityOf('1,5')).toBe('1.5')
    expect(quantityOf(' 2 ')).toBe('2')
    expect(quantityOf('0')).toBeNull()
    expect(quantityOf('1.23456')).toBeNull()
    expect(quantityOf('abc')).toBeNull()
  })

  it('holds Create draft with the first thing missing, then sends the body the API takes', () => {
    let draft: SampleDraft = withDefaults(emptyDraft(TODAY), CHOICES)
    expect(draft.siteId).toBe(IDS.site)
    const held = (over: Partial<Parameters<typeof createHeld>[0]> = {}) => createHeld({ draft, choices: CHOICES, can, companyId: 'c1', busy: false, today: TODAY, ...over })
    expect(held({ can: sourcingCan(SOURCING_ROLES_DEMO.planner) })).toBe('held.manage')
    expect(held({ choices: null })).toBe('held.choices')
    expect(held()).toBe('held.supplier')
    draft = { ...draft, partyId: IDS.tannery }
    expect(held()).toBe('held.style')
    draft = withStyle(draft, IDS.styleJkt, CHOICES)
    draft = { ...draft, roundId: IDS.styleRound }
    expect(held()).toBe('held.lineMaterial')
    draft = { ...draft, lines: [withMaterial(draft.lines[0]!, leather)] }
    expect(held()).toBeNull()
    expect(held({ draft: { ...draft, lines: [{ ...draft.lines[0]!, quantity: '0' }] } })).toBe('held.lineQuantity')
    expect(held({ draft: { ...draft, lines: [{ ...draft.lines[0]!, needDate: '2026-01-01' }] } })).toBe('held.linePast')
    expect(held({ draft: { ...draft, requestedDate: '2026-01-01' } })).toBe('held.requestedPast')
    // Another style drops the round of the first.
    expect(withStyle(draft, CHOICES.styles[1]!.id, CHOICES).roundId).toBeNull()
    expect(bodyOf({ ...draft, note: '  ', lines: [{ ...draft.lines[0]!, quantity: '2,5', description: ' 1 pelle ' }] }, 'c1')).toEqual({
      companyId: 'c1',
      siteId: IDS.site,
      partyId: IDS.tannery,
      developmentStyleId: IDS.styleJkt,
      sampleRoundId: IDS.styleRound,
      requestedDate: null,
      note: null,
      lines: [{ what: 'HIDE', itemId: IDS.leather, itemColourId: null, quantity: '2.5', uom: 'HIDE', needDate: TODAY, description: '1 pelle' }],
    })
  })

  it('says a refusal in the page’s words, at its line', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/HIDE_NOT_LEATHER' }, { path: 'body/lines/1/itemId' }])
    expect(problemOf(refused)).toEqual({ key: 'refusal.HIDE_NOT_LEATHER', field: 'itemId', line: 1 })
    expect(problemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/lines/0/uom' }]))).toEqual({ key: 'invalid.line.uom', field: 'uom', line: 0 })
    expect(problemOf(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/developmentStyleId' }]))).toMatchObject({ key: 'invalid.developmentStyleId', line: null })
    expect(problemOf(new ApiError('not_found', 404, 'not_found', 'x'))).toMatchObject({ key: 'problem.gone' })
    expect(problemOf(new Error('x')).key).toBe('problem.write')
    expect(readProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('problem.forbidden')
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NAMESPACE = 'purchasing-sourcing'
const TOP = [...new Set(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))].filter((key) => !['status', 'what', 'project', 'items'].includes(key))
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("purchasing.manage"). */
const SAID = /\b(?:purchasing\.[a-zA-Z.]+)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records']) }, createElement(View, { model })))
}

describe('RFQs & sourcing: the words', () => {
  it('every key in it and en; every word the screens name exists; every code has its words', () => {
    expect(Object.keys(CATALOGUE.it[NAMESPACE] ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:held|refusal|problem|notice|invalid)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NAMESPACE] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      for (const code of SAMPLE_ORDER_REFUSALS) expect(has(`refusal.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of PURCHASE_ORDER_STATUSES) expect(has(`status.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of SAMPLE_LINE_KINDS) expect(has(`what.${code}`), `${locale} ${code}`).toBe(true)
      for (const code of UOMS) expect(has(`uom.${code}`), `${locale} ${code}`).toBe(true)
      for (const field of ['itemId', 'itemColourId', 'quantity', 'uom', 'needDate', 'description', 'unitPrice']) expect(has(`invalid.line.${field}`), `${locale} ${field}`).toBe(true)
      for (const field of ['partyId', 'siteId', 'developmentStyleId', 'sampleRoundId', 'requestedDate', 'note', 'contactId']) expect(has(`invalid.${field}`), `${locale} ${field}`).toBe(true)
    }
  })

  it(`SCR-222: ${designScreen.cases.length} cases × it, en with no key or placeholder left`, () => {
    for (const entry of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = render(designScreen as unknown as DesignScreen<unknown>, entry.model, locale).replace(SAID, '')
        expect(html.length, `SCR-222/${entry.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-222/${entry.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `SCR-222/${entry.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })

  it('SCR-222 names every state and role case the design asks for', () => {
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['normal', 'loading', 'error', 'empty', 'filtered-empty', 'no-permission', 'planner', 'new', 'new-filled', 'new-hide-refused', 'selected', 'many', 'keys']))
  })
})
