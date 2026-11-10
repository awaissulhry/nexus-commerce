import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CERTIFICATE_KINDS } from '@nexus/factory-domain/compliance/certificates-depth/bodies'
import { LEVEL_FAMILIES, LEVEL_VOCABULARY } from '@nexus/factory-domain/compliance/certificates-depth/levels'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as bodiesScreen } from '../bodies/fixtures'
import { designScreen as listScreen, byNumber, CERTIFICATES } from '../fixtures'
import { certCan, filterRows, inView } from '../model'
import { designScreen as recordScreen } from '../record/fixtures'
import { DEPTH_GARMENT, DEPTH_GARMENT_TYPED, DEPTH_GLOVE, DEPTH_GLOVE_DRAFT, DEPTH_OWN, DEPTH_OWN_NO_BASE, DEPTH_PROTECTOR } from './demo/fixtures'
import { BODIES, BODY_0000, BODY_9990, BODY_9991 } from './bodies-demo/fixtures'
import {
  baseHeld,
  blankBodyDraft,
  blankDepthDraft,
  bodiesCsv,
  bodyDraftOf,
  bodyDraftProblems,
  bodyFormHeld,
  bodyInputOf,
  bodyRows,
  bodyScopeFor,
  closedBodies,
  DEPTH_NS,
  fiveYearWords,
  levelsDraftProblems,
  levelsHeld,
  nandoHref,
  numberFixed,
  pickableBodies,
  pickHeld,
  spanParts,
  supplierHeld,
  supplierVerb,
  writeHeld,
} from './model'

/**
 * B-W2b-255 — certificates in depth on the web: who may write what and why it is held, the five-year words, the levels,
 * the own-brand base, a part's supplier, the Notified bodies directory and its form, the new saved views, every key in
 * Italian and English, and every W2b design case (SCR-050, SCR-051, SCR-291) drawn in both languages with no key on screen.
 */

const MANAGE = certCan(['compliance.certificates.view', 'compliance.certificates.manage', 'parties.view', 'product.materials.view'])
const VIEW = certCan(['compliance.certificates.view'])

describe('the five-year words (PRD-282)', () => {
  it('says the span of a validity that is too long, nothing for one that holds', () => {
    expect(fiveYearWords('2026-10-15', '2031-12-14')).toEqual({ span: { years: 5, months: 2, days: 0 }, latest: '2031-10-15', years: 5 })
    expect(fiveYearWords('2026-10-15', '2031-10-14')).toBeNull()
    expect(spanParts({ years: 5, months: 0, days: 3 })).toEqual([
      { unit: 'years', count: 5 },
      { unit: 'days', count: 3 },
    ])
  })
})

describe('what a depth write needs (held in words)', () => {
  it('holds every write without manage', () => {
    expect(writeHeld(DEPTH_GARMENT_TYPED, VIEW, 'body')).toBe('held.manage')
    expect(writeHeld({ ...DEPTH_GARMENT_TYPED, mayManage: false }, MANAGE, 'body')).toBe('held.manage')
  })

  it('lets a registered certificate link its own body once', () => {
    expect(writeHeld(DEPTH_GARMENT_TYPED, MANAGE, 'body')).toBeNull()
    expect(writeHeld(DEPTH_GARMENT, MANAGE, 'body')).toBe('held.filledOnce')
    expect(writeHeld({ ...DEPTH_GARMENT_TYPED, body: { ...DEPTH_GARMENT_TYPED.body, matching: [] } }, MANAGE, 'body')).toBe('body.held.noMatch')
    expect(pickableBodies(DEPTH_GARMENT_TYPED, BODIES)).toEqual([BODY_0000])
  })

  it('offers a draft every active body, and says when nothing is picked or the same', () => {
    expect(pickableBodies(DEPTH_GLOVE_DRAFT, BODIES).map((body) => body.number)).toEqual(['0000', '9990', '9991'])
    expect(pickHeld(DEPTH_GLOVE_DRAFT, blankDepthDraft(), false)).toBe('body.held.pick')
    expect(pickHeld(DEPTH_GLOVE_DRAFT, { ...blankDepthDraft(), bodyId: BODY_9991.id }, false)).toBe('body.held.same')
    expect(pickHeld(DEPTH_GLOVE_DRAFT, { ...blankDepthDraft(), bodyId: BODY_0000.id }, false)).toBeNull()
  })

  it('takes glove levels in the vocabulary, the level first', () => {
    expect(writeHeld(DEPTH_GLOVE_DRAFT, MANAGE, 'levels')).toBeNull()
    expect(writeHeld(DEPTH_GLOVE, MANAGE, 'levels')).toBe('held.final')
    expect(writeHeld(DEPTH_GARMENT, MANAGE, 'levels')).toBe('levels.held.none')
    expect(levelsDraftProblems(DEPTH_GLOVE_DRAFT, { knuckle: 'KP' })).toHaveProperty('level')
    expect(levelsHeld(DEPTH_GLOVE_DRAFT, { knuckle: 'KP' }, false)).toBe('levels.held.invalid')
    expect(levelsHeld(DEPTH_GLOVE_DRAFT, { level: '2', knuckle: 'KP' }, false)).toBeNull()
    expect(levelsHeld(DEPTH_GLOVE_DRAFT, {}, false)).toBe('levels.held.same')
  })

  it("rests only a brand's certificate on a base", () => {
    expect(writeHeld(DEPTH_GARMENT, MANAGE, 'base')).toBe('base.held.notBrand')
    expect(writeHeld(DEPTH_OWN, MANAGE, 'base')).toBe('held.filledOnce')
    expect(writeHeld(DEPTH_OWN_NO_BASE, MANAGE, 'base')).toBeNull()
    expect(baseHeld(DEPTH_OWN_NO_BASE, blankDepthDraft(), false)).toBe('base.held.pick')
    expect(baseHeld(DEPTH_OWN_NO_BASE, { ...blankDepthDraft(), baseId: byNumber('CERT-DEMO-0001').id }, false)).toBeNull()
  })

  it('names a part’s supplier once; then only its article code changes', () => {
    const [named, open] = DEPTH_PROTECTOR.boughtIn
    expect(supplierVerb(named!)).toBe('code')
    expect(supplierVerb(open!)).toBe('name')
    expect(supplierHeld(open!, blankDepthDraft(), MANAGE, false)).toBe('supplier.held.pick')
    expect(supplierHeld(open!, { ...blankDepthDraft(), supplierId: 'x' }, VIEW, false)).toBe('held.manage')
    expect(supplierHeld(open!, { ...blankDepthDraft(), supplierId: 'x' }, MANAGE, false)).toBeNull()
    expect(supplierHeld(named!, { ...blankDepthDraft(), supplierId: 'other' }, MANAGE, false)).toBe('supplier.held.once')
    expect(supplierHeld(named!, { ...blankDepthDraft(), supplierId: named!.supplier!.id, articleCode: named!.supplierArticleCode! }, MANAGE, false)).toBe('supplier.held.same')
  })
})

describe('the Notified bodies directory (PRD-286)', () => {
  it('filters by status and words', () => {
    expect(bodyRows(BODIES, 'ACTIVE', '').map((body) => body.number)).toEqual(['0000', '9990', '9991'])
    expect(bodyRows(BODIES, 'ARCHIVED', '').map((body) => body.name)).toEqual(['Demo Test Lab (earlier entry)'])
    expect(bodyRows(BODIES, 'ALL', 'impact').map((body) => body.number)).toEqual(['9990'])
  })

  it('checks the scope for the certificate’s kind and offers only an https NANDO link', () => {
    expect(BODY_0000.clothing.state).toBe('LISTED')
    expect(BODY_9990.clothing.state).toBe('NOT_LISTED')
    expect(bodyScopeFor(BODY_9990, 'PROTECTOR').state).toBe('LISTED')
    expect(bodyScopeFor(BODY_9991, 'GLOVE').state).toBe('NO_SCOPES')
    expect(nandoHref(BODY_0000)).toBe('https://example.org/nando/0000')
    expect(nandoHref({ nandoUrl: 'javascript:alert(1)' })).toBeNull()
  })

  it('checks the form as the database does, field by field', () => {
    expect(bodyDraftProblems(blankBodyDraft())).toEqual({ number: 'bodyForm.problem.number', name: 'bodyForm.problem.name', address: 'bodyForm.problem.address' })
    expect(bodyDraftProblems({ ...bodyDraftOf(BODY_0000), nandoUrl: 'http://example.org', contactEmail: 'no' })).toEqual({ nandoUrl: 'bodyForm.problem.nandoUrl', contactEmail: 'bodyForm.problem.contactEmail' })
    expect(bodyInputOf({ ...bodyDraftOf(BODY_0000), scopes: ' A \n\na\nB ', country: 'it' })).toMatchObject({ scopes: ['A', 'B'], country: 'IT' })
  })

  it('holds Add without the right over every company; fixes a linked number', () => {
    const open = { ...closedBodies(), open: true, form: { mode: 'new' as const, bodyId: null, draft: blankBodyDraft(), touched: [] } }
    expect(bodyFormHeld(open, MANAGE, false)).toBe('bodies.held.manage')
    expect(bodyFormHeld(open, MANAGE, true)).toBe('bodyForm.problem.number')
    expect(bodyFormHeld({ ...open, form: { ...open.form, draft: bodyDraftOf(BODY_9991) } }, MANAGE, true)).toBeNull()
    expect(numberFixed(BODY_0000)).toBe(true)
    expect(numberFixed(BODY_9991)).toBe(false)
  })

  it('exports the selected bodies as CSV rows', () => {
    const rows = bodiesCsv([BODY_0000], ['n'], { status: () => 'Active', scope: () => 'Listed' })
    expect(rows[1]).toEqual(['0000', 'Demo Test Lab', 'IT', 'Via Demo 1, 00100 Roma (RM)', BODY_0000.scopes.join('; '), 'Listed', 'https://example.org/nando/0000', 'certification@example.org', '+39 000 0000000', 5, 'Active'])
  })
})

describe('the register’s W2b saved views (design ce-grid)', () => {
  it('lists garments, protectors, gloves, the 90-day horizon and the brand-held certificates', () => {
    const numbers = (view: Parameters<typeof inView>[1]) => filterRows(CERTIFICATES, { view, kind: 'all', q: '' }).map((row) => row.number)
    expect(numbers('garment')).toEqual(['CERT-DEMO-0001', 'CERT-DEMO-0002', 'CERT-DEMO-0004', 'CERT-DEMO-0005', 'CERT-DEMO-0008'])
    expect(numbers('protectors')).toEqual(['CERT-DEMO-0003', 'CERT-DEMO-0007'])
    expect(numbers('gloves')).toEqual(['CERT-DEMO-0006'])
    expect(numbers('privateLabel')).toEqual(['CERT-DEMO-0008'])
    expect(numbers('expiring90').every((number) => byNumber(number).daysToExpiry <= 90)).toBe(true)
  })
})

// ---- words ----------------------------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('..', import.meta.url))
const has = (namespace: string, key: string) => LOCALES.every((locale) => {
  const dictionary = CATALOGUE[locale][namespace] ?? {}
  return dictionary[key] !== undefined || dictionary[`${key}_one`] !== undefined
})

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') ? [join(dir, entry.name)] : []))
}

describe('every depth key in Italian and English', () => {
  it('the literal keys of the views and models, and the families built from codes', () => {
    const literal = new Set<string>()
    for (const file of [...files(join(HERE, 'depth')), ...files(join(HERE, 'bodies'))]) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\bd\(\s*'([a-zA-Z][\w.-]*)'/g)) literal.add(match[1]!)
      for (const match of text.matchAll(/'((?:held|body|levels|base|supplier|bodies|bodyForm|write|pick|own|five|parts)\.[\w.]+)'/g)) literal.add(match[1]!)
      for (const match of text.matchAll(/plainKey="([\w.]+)"/g)) literal.add(match[1]!)
    }
    const built = [
      ...['LISTED', 'NOT_LISTED', 'NO_SCOPES'].flatMap((state) => CERTIFICATE_KINDS.map((kind) => `scope.${state}.${kind}`)),
      ...LEVEL_FAMILIES.flatMap((family) => [`levels.title.${family}`, `levels.intro.${family}`]),
      ...LEVEL_FAMILIES.flatMap((family) => LEVEL_VOCABULARY[family].properties.map((property) => `levels.property.${property.key}`)),
      ...['A', 'B'].map((value) => `levels.value.type.${value}`),
      ...['FB', 'CB', 'LB'].map((value) => `levels.value.backArea.${value}`),
      ...['FULL', 'DIVIDED'].map((value) => `levels.value.chestArea.${value}`),
      ...['NOT_REGISTERED', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED', 'NOT_YET'].map((state) => `own.standing.${state}`),
      ...['ACTIVE', 'ARCHIVED', 'ALL'].map((filter) => `bodies.filterValue.${filter}`),
      ...['ACTIVE', 'ARCHIVED'].map((status) => `bodies.status.${status}`),
      ...['name', 'code'].map((verb) => `parts.${verb}`),
      ...['years', 'months', 'days'].map((unit) => `span.${unit}`),
      ...['LISTED', 'NOT_LISTED', 'NO_SCOPES'].map((state) => `scope.short.${state}`),
      'nando.short',
      'nando.noneShort',
    ]
    expect(literal.size).toBeGreaterThan(80)
    expect([...literal, ...built].filter((key) => !has(DEPTH_NS, key))).toEqual([])
    expect(['garment', 'protectors', 'gloves', 'expiring90', 'privateLabel'].filter((view) => !has('certificates', `view.${view}`))).toEqual([])
  })
})

// ---- every W2b design case ------------------------------------------------------------------------------------------------

describe('every W2b design case draws in both languages with no key left on screen', () => {
  const keys = new Set<string>()
  for (const key of Object.keys(CATALOGUE.en[DEPTH_NS] ?? {})) keys.add(key.replace(/_(one|other)$/, ''))
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  const leftKey = (html: string): string | null => {
    for (const key of keys) {
      if (!key.includes('.')) continue
      const at = html.indexOf(key)
      if (at < 0) continue
      const before = html[at - 1] ?? ' '
      const after = html[at + key.length] ?? ' '
      if (!/[\w.-]/.test(before) && !/[\w.]/.test(after)) return key
    }
    return null
  }
  for (const screen of [listScreen, recordScreen, bodiesScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      const cases = screen.screen === 'SCR-291' ? screen.cases : screen.cases.filter((item) => item.label.startsWith('W2b'))
      it(`${screen.screen} in ${locale}: ${cases.length} cases`, () => {
        expect(cases.length).toBeGreaterThan(5)
        for (const item of cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(leftKey(html), `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the Notified body tab says the scope check and NANDO in both languages', () => {
    const tab = recordScreen.cases.find((item) => item.id === 'w2b-body')!
    const en = render(recordScreen as DesignScreen<unknown>, tab.model, 'en')
    const it = render(recordScreen as DesignScreen<unknown>, tab.model, 'it')
    expect(en).toContain('Listed for protective motorcycle clothing')
    expect(en).toContain('NANDO entry of 0000')
    expect(it).toContain("Notificato per l&#x27;abbigliamento protettivo da moto")
  })

})
