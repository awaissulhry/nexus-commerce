import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DEFAULT_EDIT_RULES } from '@nexus/factory-domain/product/lifecycle/rules'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { AUDIT, COMPANY_FRESH, COMPANY_ID, COMPANY_SETTINGS, TENANT_SETTINGS, TYPES, typeOf } from './demo'
import { designScreen } from './fixtures'
import {
  addressOf,
  changeHeld,
  changedByOf,
  createTypeBody,
  descendantsOf,
  EDIT_KINDS,
  EDIT_RULES,
  inheritedOf,
  inheritedRules,
  ITEM_KINDS,
  kindHeld,
  letsThrough,
  mayKeepTypeOf,
  movable,
  parentChoices,
  percentInput,
  PPE_CATEGORIES,
  PRODUCT_TYPES,
  queryOf,
  REQUIRABLE_ATTRIBUTES,
  rulesBody,
  rulesChanged,
  rulesDraftOf,
  rulesLoosenings,
  rulesPreview,
  STYLE_LIFECYCLES,
  toleranceBody,
  toleranceChanges,
  toleranceDraftOf,
  toleranceHeld,
  tolerancePreview,
  TOLERANCES,
  typeChanged,
  typeDraftOf,
  typeProblems,
  typesShown,
  typeTree,
  updateTypeBody,
  writeProblemOf,
} from './model'

const params = (query: string) => new URLSearchParams(query)

describe('Product settings (SCR-251): the address', () => {
  it('reads and writes whose settings, which types and the type dialog', () => {
    expect(addressOf(params(''))).toEqual({ scope: 'company', type: null, status: 'ACTIVE' })
    expect(addressOf(params('scope=all&status=ALL&type=new'))).toEqual({ scope: 'all', type: 'new', status: 'ALL' })
    expect(addressOf(params('type=not-an-id&status=x'))).toEqual({ scope: 'company', type: null, status: 'ACTIVE' })
    expect(queryOf({ scope: 'all', type: TYPES[0]!.id, status: 'ARCHIVED' })).toBe(`?scope=all&status=ARCHIVED&type=${TYPES[0]!.id}`)
    expect(queryOf({ scope: 'company', type: null, status: 'ACTIVE' })).toBe('')
  })

  it('a product type opens in its dialog on this page (record links)', () => {
    expect(recordAddress({ type: 'ProductTypeProfile', id: 't1' }, OFFICE_PAGES)).toBe('/products/settings?type=t1')
  })
})

describe('edit rules per lifecycle state (PRD-182)', () => {
  const company = COMPANY_SETTINGS()
  const tenant = TENANT_SETTINGS()

  it('starts from the scope’s own rules; a state without one follows every company, then the default', () => {
    expect(rulesDraftOf(company)).toMatchObject({ SAMPLING: 'FREE', IN_PRODUCTION: null })
    const inherited = inheritedRules('company', company, tenant)
    expect(inherited.IN_PRODUCTION).toEqual({ rule: 'CHANGE_ORDER', source: 'TENANT' })
    expect(inheritedRules('all', tenant, tenant).IN_PRODUCTION).toEqual({ rule: DEFAULT_EDIT_RULES.IN_PRODUCTION, source: 'DEFAULT' })
    // Without every company's read, a state the company keeps no rule for still says what it follows; one it keeps is unknown.
    expect(inheritedRules('company', company, null).IN_PRODUCTION).toEqual({ rule: 'CHANGE_ORDER', source: 'TENANT' })
    expect(inheritedRules('company', company, null).SAMPLING).toBeNull()
  })

  it('shows what is in force once saved, as the API reads it', () => {
    const draft = { ...rulesDraftOf(company), SAMPLING: null, DISCONTINUED: 'CHANGE_ORDER' as const }
    const preview = rulesPreview('company', draft, inheritedRules('company', company, tenant))
    expect(preview.SAMPLING).toEqual({ rule: 'NEW_REVISION', source: 'TENANT' })
    expect(preview.DISCONTINUED).toEqual({ rule: 'CHANGE_ORDER', source: 'COMPANY' })
    expect(rulesChanged(company, draft)).toEqual(['SAMPLING', 'DISCONTINUED'])
    expect(rulesBody(company, draft, null)).toEqual({ companyId: COMPANY_ID, version: 3, editRules: { SAMPLING: null, DISCONTINUED: 'CHANGE_ORDER' } })
    // A company that never saved makes its row: no version.
    const fresh = COMPANY_FRESH()
    expect(rulesBody(fresh, { ...rulesDraftOf(fresh), CONCEPT: 'NEW_REVISION' }, null)).toEqual({ companyId: COMPANY_ID, editRules: { CONCEPT: 'NEW_REVISION' } })
  })

  it('names each state that lets more through than today (asked with a reason); tighter asks nothing', () => {
    const inherited = inheritedRules('all', tenant, tenant)
    const looser = { ...rulesDraftOf(tenant), IN_PRODUCTION: 'NEW_REVISION' as const, DISCONTINUED: null }
    // DISCONTINUED back to the default (BLOCKED) is no loosening.
    expect(rulesLoosenings(tenant, looser, inherited, 'all')).toEqual([{ state: 'IN_PRODUCTION', from: 'CHANGE_ORDER', to: 'NEW_REVISION' }])
    expect(rulesLoosenings(tenant, { ...rulesDraftOf(tenant), CONCEPT: 'BLOCKED' }, inherited, 'all')).toEqual([])
    // A company that follows "change order" and sets "edit freely" loosens; following again tightens back.
    const companyInherited = inheritedRules('company', company, tenant)
    expect(rulesLoosenings(company, { ...rulesDraftOf(company), PHASE_OUT: 'FREE' }, companyInherited, 'company')).toEqual([{ state: 'PHASE_OUT', from: 'CHANGE_ORDER', to: 'FREE' }])
    expect(rulesLoosenings(company, { ...rulesDraftOf(company), SAMPLING: null }, companyInherited, 'company')).toEqual([])
    expect(rulesBody(tenant, looser, 'Small factory')).toMatchObject({ companyId: null, version: 5, reason: 'Small factory' })
  })

  it('says what each rule lets through from factory-domain’s own check (the table in its head)', () => {
    const table = Object.fromEntries(EDIT_KINDS.map((kind) => [kind, EDIT_RULES.map((rule) => letsThrough(rule, kind))]))
    expect(table).toEqual({
      DETAILS: ['yes', 'yes', 'yes', 'no'],
      SPEC: ['yes', 'withDraft', 'withDraft', 'no'],
      NEW_REVISION: ['yes', 'yes', 'changeOrder', 'no'],
      DRAFT: ['yes', 'yes', 'yes', 'no'],
      RELEASE: ['yes', 'yes', 'yes', 'no'],
    })
  })

  it('holds a change with its reason before the click', () => {
    expect(changeHeld(null, 'company', false, false)).toBe('held.reading')
    expect(changeHeld(COMPANY_SETTINGS(false), 'company', false, false)).toBe('held.noRight')
    expect(changeHeld(TENANT_SETTINGS(false), 'all', false, false)).toBe('held.noRightAll')
    expect(changeHeld(company, 'company', false, true)).toBe('held.offline')
    expect(changeHeld(company, 'company', true, false)).toBe('held.busy')
    expect(changeHeld(company, 'company', false, false)).toBeNull()
  })

  it('"Changed by" per card from the audit trail: the newest entry that touched the card’s fields', () => {
    expect(changedByOf(AUDIT, 'editRule')).toEqual({ at: AUDIT[0]!.at, by: 'Anna Demo' })
    expect(changedByOf(AUDIT, 'consumptionTolerance')).toEqual({ at: AUDIT[1]!.at, by: 'Marco Demo' })
    expect(changedByOf([], 'editRule')).toBeNull()
  })
})

describe('consumption tolerance (PRD-105)', () => {
  const company = COMPANY_SETTINGS()
  const tenant = TENANT_SETTINGS()

  it('reads the scope’s own rules; a typed percent takes a comma in Italian', () => {
    const draft = toleranceDraftOf(tenant, 'it')
    expect(draft.rule).toBe('WARN_ABOVE')
    expect(draft.byKind.LEATHER).toEqual({ rule: 'WARN_ABOVE', percent: '5' })
    expect(draft.byKind.LINING).toEqual({ rule: 'NONE', percent: '' })
    expect(percentInput('2,5')).toBe('2.5')
    expect(percentInput(' 3 ')).toBe('3')
    for (const bad of ['0', '120', 'circa 5', '1.23456', '']) expect(percentInput(bad), bad).toBeNull()
  })

  it('shows what the cutting table reads once saved: a kind’s own rule, the general rule, every company’s', () => {
    const draft = toleranceDraftOf(company, 'en')
    const preview = tolerancePreview('company', draft, tenant)
    expect(preview.general).toEqual({ rule: 'WARN_ABOVE', percent: '3', source: 'TENANT', byKind: false })
    expect(preview.kinds.LEATHER).toEqual({ rule: 'WARN_ABOVE', percent: '5', source: 'TENANT', byKind: true })
    expect(preview.kinds.PROTECTOR).toEqual({ rule: 'MATCH', percent: null, source: 'COMPANY', byKind: true })
    // A general rule of the company's own comes before every company's per kind.
    const own = tolerancePreview('company', { ...draft, rule: 'MAY_DIFFER' }, tenant)
    expect(own.kinds.LEATHER).toEqual({ rule: 'MAY_DIFFER', percent: null, source: 'COMPANY', byKind: false })
    expect(tolerancePreview('all', toleranceDraftOf(tenant, 'en'), null).kinds.TEXTILE).toEqual({ rule: 'WARN_ABOVE', percent: '3', source: 'TENANT', byKind: false })
  })

  it('counts and sends only what changed, the percent only with "warn above"', () => {
    const draft = toleranceDraftOf(company, 'it')
    expect(toleranceChanges(company, draft, 'it')).toBe(0)
    const changed = { ...draft, rule: 'WARN_ABOVE' as const, percent: '4,5', byKind: { ...draft.byKind, LEATHER: { rule: 'MATCH' as const, percent: '' }, PROTECTOR: { rule: 'NONE' as const, percent: '' } } }
    expect(toleranceChanges(company, changed, 'it')).toBe(3)
    expect(toleranceBody(company, changed, 'it')).toEqual({
      companyId: COMPANY_ID,
      version: 3,
      consumptionTolerance: 'WARN_ABOVE',
      consumptionTolerancePct: '4.5',
      consumptionToleranceByKind: { LEATHER: { rule: 'MATCH' }, THREAD: { rule: 'MAY_DIFFER' } },
    })
    // Back to following: both cleared together (the API checks them together).
    expect(toleranceBody(tenant, { ...toleranceDraftOf(tenant, 'en'), rule: null }, 'en')).toEqual({ companyId: null, version: 5, consumptionTolerance: null, consumptionTolerancePct: null })
    expect(toleranceHeld({ ...draft, rule: 'WARN_ABOVE', percent: '' })).toBe('tolerance.problem.percent')
    expect(toleranceHeld({ ...draft, byKind: { ...draft.byKind, PADDING: { rule: 'WARN_ABOVE', percent: '101' } } })).toBe('tolerance.problem.percent')
    expect(toleranceHeld(changed)).toBeNull()
  })
})

describe('product types (PRD-008)', () => {
  it('lists the types as a tree: each parent before its children, a child whose parent is hidden at the top', () => {
    const shown = typeTree(typesShown(TYPES, 'company', 'ACTIVE'))
    expect(shown.map((node) => `${'  '.repeat(node.depth)}${node.type.code}`)).toEqual(['DEMO-JKT', '  DEMO-JKT-TOUR', '    DEMO-JKT-LADY', '  DEMO-JKT-URB', 'DEMO-TRS', 'DEMO-SUIT', 'DEMO-GLV'])
    expect(typesShown(TYPES, 'all', 'ALL').map((type) => type.code)).not.toContain('DEMO-JKT-TOUR')
    expect(typeTree(typesShown(TYPES, 'company', 'ARCHIVED')).map((node) => [node.type.code, node.depth])).toEqual([['DEMO-VEST', 0]])
    // Every company's view: the company's own child (and its own child) are not listed; the tree never loses a node.
    expect(typeTree(typesShown(TYPES, 'all', 'ACTIVE')).map((node) => node.type.code)).toEqual(['DEMO-JKT', 'DEMO-JKT-URB', 'DEMO-TRS', 'DEMO-SUIT', 'DEMO-GLV'])
  })

  it('offers parents of the same garment, active, of the type’s company or every company, never itself or a child', () => {
    const tour = typeOf('DEMO-JKT-TOUR')
    expect(descendantsOf(TYPES, typeOf('DEMO-JKT').id)).toEqual(new Set([typeOf('DEMO-JKT').id, tour.id, typeOf('DEMO-JKT-LADY').id, typeOf('DEMO-JKT-URB').id]))
    expect(parentChoices(TYPES, typeDraftOf(tour, tour.companyId)).map((type) => type.code)).toEqual(['DEMO-JKT', 'DEMO-JKT-URB'])
    expect(parentChoices(TYPES, typeDraftOf(typeOf('DEMO-JKT'), null)).map((type) => type.code)).toEqual([])
    // An every-company type cannot take a company's type as its parent.
    expect(parentChoices(TYPES, { ...typeDraftOf(null, null), productType: 'JACKET' }).map((type) => type.code)).toEqual(['DEMO-JKT', 'DEMO-JKT-URB'])
    expect(parentChoices(TYPES, { ...typeDraftOf(null, COMPANY_ID), productType: 'JACKET' }).map((type) => type.code)).toEqual(['DEMO-JKT', 'DEMO-JKT-LADY', 'DEMO-JKT-TOUR', 'DEMO-JKT-URB'])
  })

  it('checks the form at its fields, with what the parent gives', () => {
    const fresh = typeDraftOf(null, COMPANY_ID)
    expect(typeProblems(fresh, null)).toEqual({ code: 'type.problem.code', name: 'type.problem.name' })
    const gloves = { ...fresh, code: 'DEMO-GLV-W', name: 'Winter gloves', productType: 'GLOVES' as const, defaultPpeStandard: 'EN 13594:2015' }
    expect(typeProblems(gloves, null)).toEqual({ defaultPpeCategory: 'type.problem.ppeCategory' })
    // Under a parent that names the category, the standard alone is fine.
    expect(typeProblems({ ...gloves, parentId: typeOf('DEMO-GLV').id }, inheritedOf(TYPES, { ...gloves, parentId: typeOf('DEMO-GLV').id }))).toEqual({})
    expect(typeProblems({ ...gloves, code: 'A B', defaultPpeClass: 'TOO-LONG-CLASS' }, null)).toMatchObject({ code: 'type.problem.code', defaultPpeClass: 'type.problem.ppeClass' })
  })

  it('sends a new type whole and a change of one only with what changed, at its version', () => {
    const fresh = { ...typeDraftOf(null, null), code: ' DEMO-NEW ', name: 'New type', defaultPpeStandard: '  ' }
    expect(createTypeBody(fresh)).toMatchObject({ companyId: null, code: 'DEMO-NEW', name: 'New type', productType: 'JACKET', requiredAttributes: [], defaultPpeStandard: null })
    const tour = typeOf('DEMO-JKT-TOUR')
    const draft = typeDraftOf(tour, tour.companyId)
    expect(typeChanged(tour, draft)).toEqual([])
    const changed = { ...draft, name: 'Touring jackets 2027', requiredAttributes: [...draft.requiredAttributes, 'season' as const], defaultPpeClass: 'AA' }
    expect(typeChanged(tour, changed)).toEqual(['name', 'requiredAttributes', 'defaultPpeClass'])
    expect(updateTypeBody(tour, changed)).toEqual({ version: 3, name: 'Touring jackets 2027', requiredAttributes: ['netMassKg', 'brandPartyId', 'season'], defaultPpeClass: 'AA' })
    // The same attributes in another order are no change.
    expect(typeChanged(tour, { ...draft, requiredAttributes: [...draft.requiredAttributes].reverse() })).toEqual([])
  })

  it('holds the kind of garment while styles or child types use the type; Archive N / Restore N move only rows in the right state', () => {
    expect(kindHeld(typeOf('DEMO-JKT'))).toBe('type.held.kindInUse')
    expect(kindHeld(typeOf('DEMO-SUIT'))).toBeNull()
    expect(kindHeld(null)).toBeNull()
    const ids = [typeOf('DEMO-SUIT').id, typeOf('DEMO-VEST').id]
    expect(movable(TYPES, ids, 'archive').map((type) => type.code)).toEqual(['DEMO-SUIT'])
    expect(movable(TYPES, ids, 'restore').map((type) => type.code)).toEqual(['DEMO-VEST'])
  })

  it('a company’s type is kept with the company’s right, every company’s with a right over every company', () => {
    const company = COMPANY_SETTINGS(true)
    const tenantNo = TENANT_SETTINGS(false)
    expect(mayKeepTypeOf('company', company, tenantNo, false, COMPANY_ID)).toBe(true)
    expect(mayKeepTypeOf('company', company, tenantNo, false, null)).toBe(false)
    expect(mayKeepTypeOf('all', TENANT_SETTINGS(true), null, false, null)).toBe(true)
    expect(mayKeepTypeOf('company', company, TENANT_SETTINGS(true), true, COMPANY_ID)).toBe(false)
  })
})

describe('the API’s refusals in this page’s words', () => {
  const error = (kind: ConstructorParameters<typeof ApiError>[0], status: number, code: string, message: string, issues: { path: string; message: string }[] = []) => new ApiError(kind, status, code, message, null, issues)

  it('a moved row reads again; a taken code points at the field; every company’s needs a right over every company', () => {
    expect(writeProblemOf(error('conflict', 409, 'conflict', 'This ProductSettings changed since it was read (version 2)…', [{ path: 'version', message: 'The current version is 3.' }]), 'company')).toEqual({ key: 'problem.write.moved', reload: true, fields: {} })
    expect(writeProblemOf(error('conflict', 409, 'conflict', 'The product type code DEMO-GLV is taken.'), 'company')).toEqual({ key: 'problem.write.codeTaken', reload: false, fields: { code: 'type.problem.codeTaken' } })
    // The API's own check says it at the field first (400 body/code), as the live check met it.
    expect(writeProblemOf(error('invalid', 400, 'validation_failed', 'The product type is not valid.', [{ path: 'body/code', message: 'The product type code DEMO-GLV is taken.' }]), 'company')).toEqual({ key: 'problem.write.codeTaken', reload: false, fields: { code: 'type.problem.codeTaken' } })
    expect(writeProblemOf(error('conflict', 409, 'invalid_state', 'Product type DEMO-VEST is archived: restore it before changing it.'), 'company')).toMatchObject({ key: 'problem.write.archived', reload: true })
    expect(writeProblemOf(error('conflict', 409, 'conflict', 'Product type DEMO-JKT has 6 style(s) and 3 child type(s) of jacket: its kind of garment stays (another kind is a new type).'), 'company')).toMatchObject({ key: 'problem.write.kindInUse', fields: { productType: 'type.problem.kindInUse' } })
    expect(writeProblemOf(error('invalid', 400, 'validation_failed', 'The product type is not valid.', [{ path: 'body/parentId', message: 'x' }, { path: 'body/defaultPpeClass', message: 'y' }]), 'company')).toEqual({ key: 'problem.write.invalid', reload: false, fields: { parentId: 'type.problem.parent', defaultPpeClass: 'type.problem.ppe' } })
    expect(writeProblemOf(error('forbidden', 403, 'forbidden', 'A style for every company is changed only by a role over every company.'), 'all').key).toBe('problem.write.forbiddenAll')
    expect(writeProblemOf(new Error('x'), 'company').key).toBe('problem.write.internal')
  })
})

// ---- every key and every design case ------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') && entry.name !== 'fixtures.ts' && entry.name !== 'demo.ts' ? [path] : []
  })
}
const PREFIXES = ['head', 'live', 'scope', 'noAccess', 'card', 'source', 'common', 'loosen', 'keys', 'state', 'rule', 'rules', 'lets', 'kind', 'kindHint', 'tolerance', 'itemKind', 'costing', 'workCentre', 'types', 'type', 'row', 'bulk', 'held', 'garment', 'ppe', 'attr', 'problem', 'done']
const literalKeys = (): string[] => [
  ...new Set(
    sources(HERE).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]+)'/g), ...text.matchAll(new RegExp(`'((?:${PREFIXES.join('|')})\\.[a-zA-Z][\\w.]+)'`, 'g'))].map((match) => match[1]!)
    }),
  ),
]
const built = [
  ...STYLE_LIFECYCLES.map((state) => `state.${state}`),
  ...EDIT_RULES.map((rule) => `rule.${rule}`),
  ...EDIT_KINDS.flatMap((kind) => [`kind.${kind}`, `kindHint.${kind}`]),
  ...['yes', 'withDraft', 'changeOrder', 'no'].map((value) => `lets.${value}`),
  ...TOLERANCES.flatMap((rule) => [`tolerance.rule.${rule}`, `tolerance.ruleHint.${rule}`]),
  ...ITEM_KINDS.map((kind) => `itemKind.${kind}`),
  ...WORK_CENTRE_KINDS.map((kind) => `workCentre.${kind}`),
  ...PRODUCT_TYPES.map((kind) => `garment.${kind}`),
  ...PPE_CATEGORIES.map((category) => `ppe.${category}`),
  ...REQUIRABLE_ATTRIBUTES.map((attribute) => `attr.${attribute}`),
  ...['COMPANY', 'TENANT', 'DEFAULT'].map((source) => `source.${source}`),
  ...['connecting', 'live', 'offline'].map((state) => `live.${state}`),
  ...['ACTIVE', 'ARCHIVED', 'ALL'].map((status) => `types.status.${status}`),
  ...['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract', 'internal'].map((kind) => `problem.read.${kind}`),
  ...['moved', 'codeTaken', 'kindInUse', 'state', 'archived', 'invalid', 'forbidden', 'forbiddenAll', 'signed_out', 'not_found', 'rate_limited', 'unavailable', 'internal'].map((kind) => `problem.write.${kind}`),
]

describe('every key the page names exists in it and en', () => {
  for (const locale of LOCALES) {
    it(`products-settings (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.['products-settings'] ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      // A permission's name (costing.view) is not a key.
      const permissions = new Set(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name as string))
      const keys = [...literalKeys(), ...built].filter((key) => !permissions.has(key))
      expect(keys.length).toBeGreaterThan(250)
      expect(keys.filter((key) => !has(key))).toEqual([])
    })
  }
})

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = (designScreen as DesignScreen<unknown>).view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-251 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        // Permission names (product.styles.view) and standards are words, not keys.
        const html = render(item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/\b(?:product|compliance|quality|inventory|parties|money)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-251/${item.id} (${locale})`).toBeNull()
      }
    })
  }
})

describe('money by grain (A1 §2.6): the cost per minute reaches only the cost grain', () => {
  it('the Owner reads € a minute; the product developer and sales read "Not in your role"; quality reads no costing value', () => {
    const html = (id: string) => render(designScreen.cases.find((item) => item.id === id)!.model, 'en')
    expect(html('company')).toContain('€0.42 a minute')
    for (const id of ['developer', 'sales']) {
      expect(html(id), id).not.toContain('€')
      expect(html(id), id).toContain('Not in your role')
    }
    expect(html('quality')).not.toContain('€')
    expect(html('quality')).toContain('Your role does not read the costing values.')
  })
})
