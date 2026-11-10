import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { keysOf, partnerForbiddenKey, TECH_PACK_AUDIENCES } from '@nexus/factory-domain/product/techpack/rules'
import { SCAN_STATES } from '@nexus/factory-domain/product/techpack/scan'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES, WINDOW_PAGES } from '../../../../shell/nav/office-nav'
import { CAN, REV, STYLE_ID } from '../demo/fixtures'
import { abilitiesOf, STYLE_TABS, tabsFor } from '../model'
import { demoScan, demoTechPack, VERSIONS } from './demo/fixtures'
import { designScreen as tabScreen } from './fixtures'
import {
  allowedSections,
  bannerWords,
  coverageWords,
  LEFT_OUT_KINDS,
  makeHeld,
  makeProblem,
  madeWords,
  partyChoices,
  pickVersion,
  printedCode,
  readProblem,
  scanLanding,
  scanWords,
  scopeWords,
  SECTION_HOME,
  SECTIONS,
  sizesText,
  startParty,
  techPackCan,
  WINDOW_PATH,
  windowAddress,
  windowTargetOf,
  withSection,
  type MakeDraft,
} from './model'
import { CODE_GROUPS } from './view/Sections'
import { designScreen as windowScreen } from './window/fixtures'

/** B-W2b-243 (SCR-305, SCR-306): the tech pack screens' rules and words, with made-up data. */

const OWNER = techPackCan(['product.bom.view', 'product.techpacks.make', 'product.routing.view', 'compliance.certificates.view', 'money.cost', 'parties.view'])
const READER = techPackCan(['product.bom.view'])
const RANGE = ['46', '48', '50', '52', '54', '56', '58']

describe('who may do what', () => {
  it('reads with the BOM, makes with product.techpacks.make; the routing and the certificates open their sections', () => {
    expect(OWNER).toEqual({ view: true, make: true, routing: true, certificates: true, cost: true, parties: true })
    expect(READER.make).toBe(false)
    expect(allowedSections(OWNER)).toEqual([...SECTIONS])
    expect(allowedSections(READER)).toEqual(SECTIONS.filter((section) => !['CONSTRUCTION', 'PROTECTION', 'COMPLIANCE'].includes(section)))
  })

  it('the Tech pack tab follows Cost and opens with the BOM\'s right', () => {
    expect(STYLE_TABS.indexOf('techpack')).toBe(STYLE_TABS.indexOf('cost') + 1)
    expect(tabsFor(CAN.owner)).toContain('techpack')
    expect(tabsFor(abilitiesOf(['product.styles.view']))).not.toContain('techpack')
    expect(tabsFor(CAN.sales)).not.toContain('techpack')
  })

  it('the PDF window is a built window page', () => {
    expect(OFFICE_PAGES.has(WINDOW_PATH)).toBe(true)
    expect(WINDOW_PAGES.has(WINDOW_PATH)).toBe(true)
  })
})

describe('the Contents', () => {
  it('keeps the design\'s order, each section once', () => {
    expect(withSection(['BOM', 'COVER'], 'SKETCHES', true)).toEqual(['COVER', 'SKETCHES', 'BOM'])
    expect(withSection(['COVER', 'BOM'], 'COVER', false)).toEqual(['BOM'])
    expect(withSection(['COVER'], 'COVER', true)).toEqual(['COVER'])
  })

  // B-W2b-274: each section links to a tab of the style; the sketches to the Overview's gallery (B-W2b-236).
  it('links each section to a tab the style has, the sketches to the Overview', () => {
    for (const section of SECTIONS) expect(STYLE_TABS, section).toContain(SECTION_HOME[section])
    expect(SECTION_HOME.SKETCHES).toBe('overview')
  })
})

describe('Make tech pack PDF', () => {
  const draft: MakeDraft = { audience: 'INTERNAL', language: 'it', sections: [...SECTIONS], partyId: null }
  const context = { can: OWNER, online: true, busy: false, revision: true, privateLabel: null, allowed: allowedSections(OWNER) }
  const brand = { id: 'b1', code: 'BR-DEMO', name: 'Esempio Moto' }

  it('holds with the reason, in the order a person meets them', () => {
    expect(makeHeld(draft, context)).toBeNull()
    expect(makeHeld(draft, { ...context, can: READER })).toBe('techpack.held.noMake')
    expect(makeHeld(draft, { ...context, online: false })).toBe('techpack.held.offline')
    expect(makeHeld(draft, { ...context, busy: true })).toBe('techpack.held.busy')
    expect(makeHeld(draft, { ...context, revision: false })).toBe('techpack.held.noRevision')
    expect(makeHeld({ ...draft, sections: [] }, context)).toBe('techpack.held.noSections')
    expect(makeHeld(draft, { ...context, allowed: allowedSections(READER) })).toBe('techpack.held.sectionNotYours')
    expect(makeHeld({ ...draft, partyId: 'p1' }, context)).toBe('techpack.held.internalParty')
  })

  it('a private-label style\'s customer copy is for its own brand only, and starts with it', () => {
    expect(startParty('BRAND', brand)).toBe('b1')
    expect(startParty('SUBCONTRACTOR', brand)).toBeNull()
    expect(startParty('INTERNAL', brand)).toBeNull()
    expect(makeHeld({ ...draft, audience: 'BRAND', partyId: 'other' }, { ...context, privateLabel: brand })).toBe('techpack.held.privateLabel')
    expect(makeHeld({ ...draft, audience: 'BRAND', partyId: null }, { ...context, privateLabel: brand })).toBe('techpack.held.privateLabel')
    expect(makeHeld({ ...draft, audience: 'BRAND', partyId: 'b1' }, { ...context, privateLabel: brand })).toBeNull()
    expect(partyChoices('BRAND', [{ id: 'x', code: 'CLI-X', legalName: 'X', tradeName: null }], brand).map((row) => row.id)).toEqual(['b1'])
    expect(partyChoices('INTERNAL', [{ id: 'x', code: 'CLI-X', legalName: 'X', tradeName: null }], null)).toEqual([])
    expect(partyChoices('SUBCONTRACTOR', [{ id: 'z', code: 'Z', legalName: 'Z', tradeName: null }, { id: 'a', code: 'A', legalName: 'A', tradeName: null }], brand).map((row) => row.code)).toEqual(['A', 'Z'])
  })

  it('says a refusal in its own words, by the place the API names', () => {
    expect(makeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/partyId', message: 'x' }]))).toBe('techpack.problem.make.party')
    expect(makeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/sections/2', message: 'x' }]))).toBe('techpack.problem.make.sections')
    expect(makeProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/companyId', message: 'x' }]))).toBe('techpack.problem.make.company')
    expect(makeProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('techpack.problem.make.meanwhile')
    expect(makeProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('techpack.problem.make.forbidden')
    expect(makeProblem(new ApiError('internal', 500, 'internal', 'x'))).toBe('techpack.problem.make.internal')
    expect(makeProblem(new Error('x'))).toBe('techpack.problem.make.internal')
    expect(readProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('techpack.problem.read.not_found')
  })

  it('a new version, or the newest again when nothing changed', () => {
    const version = { ...VERSIONS[0]!, code: VERSIONS[0]!.code }
    expect(madeWords({ made: true, version })).toEqual({ key: 'techpack.notice.made', params: { version: 3, code: printedCode(version.code) } })
    expect(madeWords({ made: false, version }).key).toBe('techpack.notice.same')
    expect(printedCode(version.code)).toMatch(/^TP [0-9A-Z]{5}-[0-9A-Z]{5}$/)
    expect(printedCode('not a code')).toBe('not a code')
  })
})

describe('words from facts', () => {
  it('a draft or obsolete revision says so; a released one says nothing', () => {
    expect(bannerWords(demoTechPack())).toEqual({ key: 'techpack.banner.draft', params: { revision: 3 } })
    expect(bannerWords(demoTechPack({ revision: 'obsolete' }))).toEqual({ key: 'techpack.banner.obsoleteInForce', params: { revision: 1, inForce: 2 } })
    expect(bannerWords(demoTechPack({ revision: 'released' }))).toBeNull()
  })

  it('sizes, the release scope and the coverage as people read them', () => {
    expect(sizesText(['50', '46', '48'], RANGE)).toBe('46–50')
    expect(sizesText(['50', '54'], RANGE)).toBe('50, 54')
    expect(sizesText(['46', '48'], RANGE)).toBe('46, 48')
    expect(scopeWords({ scopeColourways: [], scopeSizes: [] }, RANGE).key).toBe('techpack.scope.whole')
    expect(scopeWords({ scopeColourways: ['NERO', 'ANTR'], scopeSizes: [] }, RANGE)).toEqual({ key: 'techpack.scope.colourways', params: { colourways: 'NERO, ANTR' } })
    expect(scopeWords({ scopeColourways: [], scopeSizes: ['46', '48', '50', '52', '54'] }, RANGE)).toEqual({ key: 'techpack.scope.sizes', params: { sizes: '46–54' } })
    expect(coverageWords({ required: false, covered: 0, notCovered: 0 }).key).toBe('techpack.coverage.notRequired')
    expect(coverageWords({ required: true, covered: 0, notCovered: 0 }).key).toBe('techpack.coverage.noSkus')
    expect(coverageWords({ required: true, covered: 6, notCovered: 0 })).toEqual({ key: 'techpack.coverage.all', params: { count: 6 } })
    expect(coverageWords({ required: true, covered: 18, notCovered: 2 })).toEqual({ key: 'techpack.coverage.some', params: { covered: 18, count: 20, notCovered: 2 } })
  })

  it('a scanned page\'s verdict in our words, every state', () => {
    for (const state of SCAN_STATES) expect(scanWords(demoScan(state)).key).toBe(`techpack.scan.${state}`)
    expect(scanWords({ ...demoScan('NEWER_REVISION'), newer: { revisionId: REV.r3, revision: 3, version: null, createdAt: null } }).key).toBe('techpack.scan.NEWER_REVISION_NONE')
    expect(scanWords(demoScan('NEWER_VERSION'))).toMatchObject({ params: { version: 1, revision: 3, newer: 3 }, tone: 'danger' })
    expect(scanWords(demoScan('CURRENT')).tone).toBe('success')
  })
})

describe('the PDF window and the scan', () => {
  it('its address round-trips its terms', () => {
    const address = windowAddress('/w/DEMO', { styleId: STYLE_ID, revisionId: REV.r3, versionId: VERSIONS[0]!.id })
    expect(address).toBe(`/w/DEMO/products/styles/tech-pack?style=${STYLE_ID}&rev=${REV.r3}&version=${VERSIONS[0]!.id}`)
    expect(windowTargetOf(new URL(`http://x${address}`).searchParams)).toEqual({ styleId: STYLE_ID, revisionId: REV.r3, versionId: VERSIONS[0]!.id, scan: null })
    expect(windowAddress('/w/DEMO', {})).toBe('/w/DEMO/products/styles/tech-pack')
  })

  it('a scanned QR lands in the PDF window of the company the person works in', () => {
    expect(scanLanding('0VCTY7BFRV', 'SCA')).toBe('/w/SCA/products/styles/tech-pack?scan=0VCTY7BFRV')
    expect(scanLanding(' TP 0VCTY-7BFRV ', 'S A')).toBe('/w/S%20A/products/styles/tech-pack?scan=TP+0VCTY-7BFRV')
    expect(scanLanding('0VCTY7BFRV', null)).toBeNull()
  })

  it('shows the version asked, else the scanned one, else the newest', () => {
    expect(pickVersion(VERSIONS, VERSIONS[1]!.id)?.version).toBe(2)
    expect(pickVersion(VERSIONS, null, 1)?.version).toBe(1)
    expect(pickVersion(VERSIONS, 'gone', null)?.version).toBe(3)
    expect(pickVersion([], null)).toBeNull()
  })
})

describe('a partner copy has no cost, margin, pay, minutes, supplier or person (Owner W2b-4)', () => {
  it('the made-up copies, made by factory-domain\'s rule, carry no forbidden key', () => {
    for (const audience of TECH_PACK_AUDIENCES.filter((entry) => entry !== 'INTERNAL')) {
      const view = demoTechPack({ audience })
      expect([...keysOf(view)].filter(partnerForbiddenKey), audience).toEqual([])
      expect(view.leftOut.map((entry) => entry.kind).every((kind) => (LEFT_OUT_KINDS as readonly string[]).includes(kind))).toBe(true)
    }
    expect([...keysOf(demoTechPack({ cost: true }))]).toContain('unitCost')
  })
})

// ---- words ----------------------------------------------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
}
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale]['products-techpack'] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every key the tech pack screens name exists in it and en', () => {
  it('products-techpack', () => {
    const literal = new Set<string>()
    for (const file of sources(SRC)) for (const match of readFileSync(file, 'utf8').matchAll(/['"`](techpack\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) literal.add(match[1]!)
    const built = [
      ...TECH_PACK_AUDIENCES.flatMap((audience) => [`techpack.audience.${audience}`, `techpack.audienceLong.${audience}`, `techpack.audienceHint.${audience}`]),
      ...SECTIONS.map((section) => `techpack.section.${section}`),
      ...['CONSTRUCTION', 'PROTECTION', 'COMPLIANCE'].map((section) => `techpack.why.${section}`),
      ...LEFT_OUT_KINDS.map((kind) => `techpack.leftOut.${kind}`),
      ...SCAN_STATES.map((state) => `techpack.scan.${state}`),
      ...['it', 'en'].map((language) => `techpack.language.${language}`),
      ...Object.entries(CODE_GROUPS).flatMap(([group, codes]) => codes.map((code) => `techpack.${group}.${code}`)),
      ...['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract', 'internal'].map((kind) => `techpack.problem.read.${kind}`),
      ...['signed_out', 'rate_limited', 'unavailable'].map((kind) => `techpack.problem.make.${kind}`),
    ]
    const keys = [...literal, ...built]
    expect(keys.length).toBeGreaterThan(200)
    expect(keys.filter((key) => !has(key))).toEqual([])
  })
})

// ---- every design case, both languages ---------------------------------------------------------------------------------------------

const LEFT_KEY = /\btechpack\.[a-zA-Z]+\.[a-zA-Z_.]+\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [tabScreen, windowScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(100)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the workshop and customer copies show no money; the internal one for the cost grain does', () => {
    const html = (id: string) => render(tabScreen as DesignScreen<unknown>, tabScreen.cases.find((item) => item.id === id)!.model, 'en')
    expect(html('internal')).toContain('€')
    for (const id of ['subcontractor', 'customer', 'production']) expect(html(id), id).not.toContain('€')
    expect(html('subcontractor')).toContain('This copy leaves out')
    expect(html('subcontractor')).not.toContain('Conceria Esempio')
  })

  it('an Italian page says no English of this catalogue', () => {
    const english = Object.values(CATALOGUE.en['products-techpack'] ?? {}).filter((text) => text.length > 24 && !text.includes('{'))
    for (const screen of [tabScreen, windowScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) {
        const html = render(screen, item.model, 'it')
        expect(english.filter((text) => html.includes(text)), `${screen.screen}/${item.id}`).toEqual([])
      }
    }
  })
})
