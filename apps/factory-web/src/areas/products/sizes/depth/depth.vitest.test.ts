import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { GRADE_ACTIONS } from '@nexus/factory-domain/product/grading/rules'
import { POM_KINDS, POM_ZONES } from '@nexus/factory-domain/product/measures/rules'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { designScreen as specScreen } from '../../styles/record/spec/fixtures'
import { designScreen, PANT_VIEW, POMS, RULE_VIEW } from './fixtures'
import {
  bothWays,
  cellProblem,
  depthFiltersOf,
  depthProblem,
  depthSearch,
  droppedSteps,
  givenKeys,
  libraryOf,
  libraryOfKey,
  offsetsOf,
  pomCellPatch,
  pomDraftProblems,
  ruleChanged,
  signedText,
  statusHeld,
  stepColumns,
  stepRowsOf,
  stepsOf,
  typedMeasure,
  blankPom,
  NO_DEPTH_FILTERS,
} from './model'

describe('the view switch and its address', () => {
  it('?view=poms|rules is a library; anything else (the scales\' own open|archived|all) is the scales', () => {
    expect(libraryOf('poms')).toBe('poms')
    expect(libraryOf('rules')).toBe('rules')
    // B-W2b-362: the templates view (B-W1-17) is built now: `?view=templates` and key 2 open it.
    expect(libraryOf('templates')).toBe('templates')
    for (const value of [null, '', 'open', 'archived', 'all']) expect(libraryOf(value)).toBe('scales')
    expect([1, 2, 3, 4, 5].map((key) => libraryOfKey(String(key)))).toEqual(['scales', 'templates', 'poms', 'rules', null])
  })

  it('keeps the filters, the open rule and New in the address, and reads them back', () => {
    const search = depthSearch('rules', { ...NO_DEPTH_FILTERS, status: 'all', q: ' giacca ', scaleId: 's1' }, { open: 'r1', new: true })
    expect(search).toBe('?view=rules&status=all&q=giacca&scale=s1&open=r1&new=1')
    expect(depthFiltersOf(new URLSearchParams(search))).toEqual({ status: 'all', q: 'giacca', kind: null, scaleId: 's1' })
    expect(depthSearch('poms', { ...NO_DEPTH_FILTERS, kind: 'BODY', scaleId: 'ignored' })).toBe('?view=poms&kind=BODY')
    expect(depthSearch('scales', NO_DEPTH_FILTERS)).toBe('')
  })

  it('a point and a grade rule open from a record link (search, the bell) on this page', () => {
    expect(recordAddress({ type: 'PointOfMeasure', id: 'p1', companyId: 'c0' }, OFFICE_PAGES)).toBe('/products/sizes?view=poms&open=p1')
    expect(recordAddress({ type: 'GradeRule', id: 'r1', companyId: 'c0' }, OFFICE_PAGES)).toBe('/products/sizes?view=rules&open=r1')
  })
})

describe('a point typed in the list (the API\'s rules, in our words)', () => {
  const point = POMS[0]!
  it('sends only what changed, refuses before it goes', () => {
    expect(pomCellPatch(point, 'name', '  Larghezza petto ½ ')).toBeNull()
    expect(pomCellPatch(point, 'name', 'Petto')).toEqual({ patch: { name: 'Petto' } })
    expect(pomCellPatch(point, 'name', '  ')).toEqual({ problem: 'poms.problem.name' })
    expect(pomCellPatch(point, 'howTo', '')).toEqual({ patch: { howTo: null } })
    expect(pomCellPatch(point, 'uom', 'MM')).toEqual({ patch: { uom: 'MM' } })
    expect(pomCellPatch(point, 'uom', 'in')).toEqual({ problem: 'poms.problem.uom' })
    expect(pomCellPatch(point, 'defaultTolerance', '1,0')).toBeNull()
    expect(pomCellPatch(point, 'defaultTolerance', '1,5')).toEqual({ patch: { defaultTolerance: '1.5' } })
    expect(pomCellPatch(point, 'defaultTolerance', '')).toEqual({ patch: { defaultTolerance: null } })
    expect(pomCellPatch(point, 'defaultTolerance', '-1')).toEqual({ problem: 'poms.problem.tolerance' })
    expect(pomCellPatch(point, 'defaultTolerance', '1,234')).toEqual({ problem: 'poms.problem.tolerance' })
    expect(typedMeasure('abc')).toBe(false)
  })

  it('the dialog: a code once in the library whatever the case, a name, a tolerance', () => {
    const draft = { ...blankPom(null), code: 'demo-chest_w', name: 'Petto' }
    expect(pomDraftProblems(draft, POMS.map((row) => row.code), null)).toEqual({ code: 'poms.problem.codeTaken' })
    expect(pomDraftProblems(draft, POMS.map((row) => row.code), 'DEMO-CHEST_W')).toEqual({})
    expect(pomDraftProblems({ ...draft, code: '-x', name: '', defaultTolerance: 'uno' }, [], null)).toEqual({ code: 'poms.problem.code', name: 'poms.problem.name', defaultTolerance: 'poms.problem.tolerance' })
  })

  it('a refusal in our words: in use, someone else, a code taken', () => {
    const conflict = (message: string, code = 'conflict', issues: Array<{ path: string; message: string }> = []) => new ApiError('conflict', 409, code, message, null, issues)
    expect(cellProblem(conflict('Point of measure CHEST_W is in use (3 measurement spec value(s)): its unit stay as they are.'))).toBe('poms.problem.inUse')
    expect(cellProblem(conflict('x', 'version_conflict'))).toBe('poms.problem.moved')
    expect(depthProblem(conflict('Code CHEST_W is already taken.')).key).toBe('problem.write.codeTaken')
    expect(depthProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/code', message: 'CHEST_W is taken.' }])).key).toBe('problem.write.codeTaken')
    expect(depthProblem(new ApiError('forbidden', 403, 'forbidden', 'x', null, [])).key).toBe('held.noManage')
  })

  it('Archive N / Restore N say why they are held', () => {
    expect(statusHeld([], 'ARCHIVED', true, false)).toBe('held.none')
    expect(statusHeld([{ status: 'ARCHIVED' }], 'ARCHIVED', true, false)).toBe('held.alreadyArchived')
    expect(statusHeld([{ status: 'ACTIVE' }], 'ARCHIVED', false, false)).toBe('held.noManage')
    expect(statusHeld([{ status: 'ACTIVE' }], 'ARCHIVED', true, false)).toBeNull()
  })
})

describe('the Grade rule pop-up: increments per point × size step', () => {
  it('relative: the neighbours of each fit, then any other step given (between fits too)', () => {
    expect(stepColumns('RELATIVE', '52', RULE_VIEW.sizes, givenKeys(stepRowsOf(RULE_VIEW))).slice(0, 3)).toEqual(['44>46', '46>48', '48>50'])
    const fit = stepColumns('RELATIVE', '50R', PANT_VIEW.sizes, givenKeys(stepRowsOf(PANT_VIEW)))
    expect(fit).toEqual(['48R>50R', '50R>52R', '52R>54R', '48L>50L', '50L>52L', '52L>54L', '50R>50L'])
  })

  it('absolute: from the base to every other size; steps not from the base are said and left out', () => {
    expect(stepColumns('ABSOLUTE', '52', RULE_VIEW.sizes, [])).toEqual(['52>44', '52>46', '52>48', '52>50', '52>54', '52>56', '52>58', '52>60', '52>62', '52>64'])
    expect(droppedSteps(stepRowsOf(RULE_VIEW), 'ABSOLUTE', '52')).toBe(2)
    expect(droppedSteps(stepRowsOf(RULE_VIEW), 'RELATIVE', '52')).toBe(0)
  })

  it('Save sends the standard increment, then every step given; nothing changed is held', () => {
    const rows = stepRowsOf(RULE_VIEW)
    expect(stepsOf(rows)).toEqual([
      { pointOfMeasureId: POMS[0]!.id, fromSize: null, toSize: null, increment: '2' },
      { pointOfMeasureId: POMS[0]!.id, fromSize: '58', toSize: '60', increment: '2.5' },
      { pointOfMeasureId: POMS[1]!.id, fromSize: null, toSize: null, increment: '1' },
      { pointOfMeasureId: POMS[2]!.id, fromSize: null, toSize: null, increment: '0.5' },
      { pointOfMeasureId: POMS[2]!.id, fromSize: '44', toSize: '46', increment: '-0.5' },
    ])
    const fields = { name: RULE_VIEW.name, baseSize: RULE_VIEW.baseSize, format: RULE_VIEW.format }
    expect(ruleChanged(RULE_VIEW, fields, rows)).toEqual({ fields: false, steps: false })
    expect(ruleChanged(RULE_VIEW, fields, rows.map((row, index) => (index === 1 ? { ...row, standard: '1.5' } : row)))).toEqual({ fields: false, steps: true })
    expect(bothWays(rows.map((row, index) => (index === 0 ? { ...row, steps: { ...row.steps, '60>58': '1' } } : row)))).toEqual({ code: 'DEMO-CHEST_W', from: '58', to: '60' })
  })

  it('what it grades to is the domain\'s own grading: never a silent 0', () => {
    const [chest] = stepRowsOf(RULE_VIEW)
    const offsets = offsetsOf(chest!, { baseSize: '52', format: 'RELATIVE' }, RULE_VIEW.sizes)
    expect(offsets['52']).toBe('0')
    expect(offsets['50']).toBe('-2')
    expect(offsets['60']).toBe('8.5')
    const inseam = stepRowsOf(PANT_VIEW)[1]!
    const fit = offsetsOf(inseam, { baseSize: '50R', format: 'RELATIVE' }, PANT_VIEW.sizes)
    expect(fit['50L']).toBe('4')
    expect(fit['52L']).toBe('4')
    expect(offsetsOf({ ...inseam, standard: null, steps: {} }, { baseSize: '50R', format: 'RELATIVE' }, PANT_VIEW.sizes)['52R']).toBeNull()
    expect([signedText('2', 'it'), signedText('-0.5', 'it'), signedText('0', 'en'), signedText(null, 'en')]).toEqual(['+2', '−0,5', '0', '—'])
  })
})

// ---- every key, every design case --------------------------------------------------------------------------------------

const ROOTS = [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../styles/record/spec/', import.meta.url))]
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
const PREFIXES = ['switch', 'import', 'common', 'statusView', 'status', 'kind', 'zone', 'format', 'held', 'problem', 'poms', 'rules', 'scaleTab', 'spec']
const literalKeys = (): string[] => [
  ...new Set(
    ROOTS.flatMap(sources).flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return [...text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]+)'/g), ...text.matchAll(new RegExp(`'((?:${PREFIXES.join('|')})\\.[a-zA-Z][\\w.]+)'`, 'g'))].map((match) => match[1]!)
    }),
  ),
]
const built = [
  'scaleTab.tab',
  ...['scales', 'poms', 'rules'].map((library) => `switch.${library}`),
  ...['poms', 'rules'].flatMap((which) => [`import.name.${which}`, `import.fills.${which}`]),
  ...['open', 'archived', 'all'].map((view) => `statusView.${view}`),
  ...['ACTIVE', 'ARCHIVED'].map((status) => `status.${status}`),
  ...POM_KINDS.map((kind) => `kind.${kind}`),
  ...POM_ZONES.map((zone) => `zone.${zone}`),
  ...['RELATIVE', 'ABSOLUTE'].flatMap((format) => [`format.${format}`, `format.hint.${format}`]),
  ...['code', 'name', 'kind', 'zone', 'unit', 'tolerance', 'body', 'howTo', 'status'].map((key) => `poms.csv.${key}`),
  ...['code', 'name', 'scale', 'base', 'points', 'steps', 'format', 'specs', 'status'].map((key) => `rules.csv.${key}`),
  ...['DRAFT', 'APPROVED', 'ARCHIVED'].map((status) => `spec.status.${status}`),
  ...GRADE_ACTIONS.map((action) => `spec.grade.action.${action}`),
  ...['approve', 'reopen', 'archive'].flatMap((move) => [`spec.moveDialog.${move}.title`, `spec.moveDialog.${move}.body`, `spec.moveDialog.${move}.go`, `spec.notice.${move}`]),
  ...['archived', 'approved', 'archivedSpec', 'noManage', 'rule'].map((held) => `spec.banner.${held}`),
  ...['released', 'obsolete'].map((state) => `spec.frozen.${state}`),
]

describe('every key the step names exists in it and en', () => {
  for (const locale of LOCALES) {
    it(`products-sizes-depth (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.['products-sizes-depth'] ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      const permissions = new Set(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name as string))
      const keys = [...literalKeys(), ...built].filter((key) => !permissions.has(key) && !key.endsWith('.'))
      expect(keys.length).toBeGreaterThan(350)
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
  for (const screen of [designScreen, specScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          // Permission names (product.styles.manage) are words, not keys; addresses are not text.
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/href="[^"]*"/g, '')
            .replace(/\b(?:product|compliance|quality|inventory|parties|money|files|imports)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the Italian page says no English of this step', () => {
    const html = render(designScreen as DesignScreen<unknown>, designScreen.cases.find((item) => item.id === 'rules-open')!.model, 'it')
    for (const english of ['Grade rule', 'Every step', 'What it grades to', 'Points of measure']) expect(html).not.toContain(english)
  })
})
