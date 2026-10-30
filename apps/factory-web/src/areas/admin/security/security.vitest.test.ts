import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ColDef } from '@nexus/ui/grid'
import { DRILL_KEYS, fingerprintLine } from '@nexus/factory-domain/ops/drills'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES, type Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor, placeholdersOf } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { designScreen as overviewScreen } from '../overview/fixtures'
import { designScreen as rolesScreen } from '../roles/fixtures'
import { ATTENTION_KINDS, DRILL_STATES, PROTECTION_FACTS, PROTECTION_STATES, REFUSAL_CODES, STATUS_PARTS, STATUS_STATES, type AttentionItem, type Drill, type StatusLine, type TwoFactorRole } from './api'
import { designScreen } from './fixtures'
import { bulkHeld, canTake, changesFor, drillFormErrors, drillPreview, emptyDrillForm, overallOf, refusalWords, rowHeld, statusWords } from './model'
import { attentionColumns, attentionWords } from './view/AttentionSection'
import { drillColumns, twoFactorColumns } from './view/SecurityView'

/**
 * SCR-166 Security & health (B-W2a-36), with the parts it adds to SCR-012 (Role › Scope rules › Two-factor) and SCR-165
 * (All settings › Needs attention): every word in it and en with the same placeholders, every key the code names
 * (literally or from an enum) exists, the page's rules, every design case drawn in both languages with no key left on
 * screen, and each list's cells drawn alone (AG Grid draws cells only in a browser).
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NAMESPACE = 'admin-security'
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })
const words = (locale: Locale) => CATALOGUE[locale][NAMESPACE] ?? {}
const has = (key: string) => LOCALES.every((locale) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale)))
const LEFT_KEY = /\bsec\.[a-zA-Z]+(?:\.[a-zA-Z_]+)+\b/

describe('the words of Security & health', () => {
  it('has the same keys and placeholders in it and en, all under sec.', () => {
    const en = words('en')
    const itc = words('it')
    expect(Object.keys(en).length).toBeGreaterThan(200)
    expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(key.startsWith('sec.'), key).toBe(true)
      expect(en[key]?.trim(), `en ${key}`).not.toBe('')
      expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
      expect(placeholdersOf(itc[key] ?? ''), `placeholders of ${key}`).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('has every key its code names, literally or from an enum', () => {
    const pattern = /['"`](sec\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g
    const keys = new Set<string>()
    for (const folder of ['security', 'roles', 'overview']) for (const file of sources(join(ROOT, folder))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    const built = [
      ...STATUS_PARTS.map((part) => `sec.part.${part}`),
      ...STATUS_STATES.map((state) => `sec.state.${state}`),
      ...['api.ok', 'database.ok', 'scheduled.unknown', 'backups.unknown'].map((key) => `sec.status.${key}`),
      ...PROTECTION_FACTS.flatMap((fact) => [`sec.protection.label.${fact}`, `sec.protection.hint.${fact}`]),
      ...PROTECTION_STATES.map((state) => `sec.protection.state.${state}`),
      ...DRILL_KEYS.map((key) => `sec.drill.key.${key}`),
      ...['PASSED', 'FAILED'].flatMap((result) => [`sec.drill.result.${result}`, `sec.drill.would.${result}`]),
      ...['floor', 'money', 'template'].map((lock) => `sec.tf.lock.${lock}`),
      ...REFUSAL_CODES.map((code) => `sec.tf.refusal.${code}`),
      ...DRILL_STATES.filter((state) => state !== 'ok').map((state) => `sec.attention.drill.${state}`),
    ]
    expect(keys.size).toBeGreaterThan(150)
    expect([...keys, ...built].filter((key) => !has(key))).toEqual([])
  })
})

const line = (part: StatusLine['part'], state: StatusLine['state'], over: Partial<StatusLine> = {}): StatusLine => ({ part, state, count: null, minutes: null, at: null, days: null, mode: null, ...over })
const role = (over: Partial<TwoFactorRole>): TwoFactorRole => ({ id: 'r', key: 'planner', name: 'Planner', system: true, requireMfa: false, lock: null, templateAsks: false, version: 3, holders: [], heldByMe: false, ...over })

describe('the page rules', () => {
  it('never says "all working" while a part is not watched; a failing part first', () => {
    expect(overallOf([line('api', 'ok'), line('scheduled', 'unknown')])).toEqual({ key: 'sec.overall.partly', params: { ok: 1, unknown: 1 } })
    expect(overallOf([line('api', 'ok'), line('drill', 'warning')]).key).toBe('sec.overall.attention')
    expect(overallOf([line('jobs', 'failing'), line('drill', 'warning')]).key).toBe('sec.overall.failing')
    expect(overallOf([line('api', 'ok')]).key).toBe('sec.overall.all')
    const drill = { state: 'due_soon' as const, lastOn: '2026-08-09', lastResult: 'PASSED' as const, daysAgo: 82, dueOn: '2026-11-07', daysLeft: 8 }
    expect(statusWords(line('drill', 'warning'), drill)).toEqual({ key: 'sec.drill.state.dueSoon', params: { ago: 82, left: 8 } })
    expect(statusWords(line('jobs', 'warning', { count: 3, minutes: 12 }), drill)).toEqual({ key: 'sec.status.jobs.late', params: { count: 3, minutes: 12 } })
    expect(statusWords(line('files', 'ok', { mode: 'FAKE', count: 0 }), drill).key).toBe('sec.status.files.testClean')
    expect(statusWords(line('files', 'warning', { mode: 'LIVE', count: 2 }), drill)).toEqual({ key: 'sec.status.files.live', params: { count: 2 } })
  })

  it('ticks and bulk actions: only roles that can take the change; held with the reason', () => {
    const roles = [role({ id: 'a' }), role({ id: 'b', requireMfa: true, lock: 'template' }), role({ id: 'c', requireMfa: true }), role({ id: 'd', heldByMe: true })]
    expect(rowHeld(roles[3]!, true)).toBe('sec.tf.held.mine')
    expect(rowHeld(roles[0]!, false)).toBe('sec.tf.held.right')
    expect(changesFor(roles, ['a', 'b', 'c', 'd'], true)).toEqual([{ roleId: 'a', version: 3, requireMfa: true }])
    expect(changesFor(roles, ['a', 'b', 'c'], false)).toEqual([{ roleId: 'c', version: 3, requireMfa: false }])
    expect(bulkHeld(roles, ['b'], true)).toBe('sec.tf.bulk.held.ask')
    expect(bulkHeld(roles, ['b'], false)).toBe('sec.tf.bulk.held.stop')
    expect(canTake(roles[1]!, false)).toBe(false)
    const words = refusalWords({ affected: [], openSessions: 0, refusals: [{ path: 'changes/0', code: 'held', message: 'x' }, { path: 'changes', code: 'lockOut', message: 'y' }] }, [{ roleId: 'a', version: 3, requireMfa: true }], roles)
    expect(words).toEqual([{ key: 'sec.tf.refusal.held', role: 'Planner' }, { key: 'sec.tf.refusal.lockOut', role: null }])
  })

  it('checks a drill as typed, and compares the pasted line with this database before saving', () => {
    const now = new Date('2026-10-30T09:00:00.000Z')
    const form = { ...emptyDrillForm(now), environment: 'una copia locale', backupAt: '2026-10-29T02:00:00.000Z' }
    expect(drillFormErrors(form, now)).toEqual({ restored: 'sec.drill.error.restoredEmpty' })
    const print = Object.fromEntries(DRILL_KEYS.map((key) => [key, 'ab12'.repeat(4)])) as never
    const source = { asOf: form.backupAt, fingerprint: print, line: fingerprintLine(print) }
    expect(drillFormErrors({ ...form, restored: 'NXF1 orders=1' }, now).restored).toBe('sec.drill.error.restored')
    expect(drillFormErrors({ ...form, environment: 'produzione', restored: source.line }, now)).toEqual({ environment: 'sec.drill.error.production' })
    expect(drillFormErrors({ ...form, restored: source.line, drilledOn: '2026-11-02' }, now)).toEqual({ drilledOn: 'sec.drill.error.future' })
    expect(drillPreview({ ...form, restored: source.line }, source)?.result).toBe('PASSED')
    expect(drillPreview({ ...form, restored: source.line.replace(/files=\w+/, 'files=ffffffffffffffff') }, source)?.checks.filter((check) => !check.match).map((check) => check.key)).toEqual(['files'])
    expect(drillPreview({ ...form, restored: source.line }, null)).toBeNull()
  })

  it('ships the page in the navigation, behind security.view', () => {
    expect(OFFICE_PAGES.has('/admin/security')).toBe(true)
    const rows = (permissions: string[]) => officeNavFor((permission) => permissions.includes(permission)).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    expect(rows(['security.view'])).toContain('/admin/security')
    expect(rows(['roles.view'])).not.toContain('/admin/security')
  })
})

function render(screen: DesignScreen<unknown>, model: unknown, locale: Locale): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  it('SCR-166 has every state the design names', () => {
    const ids = designScreen.cases.map((item) => item.id).join(' ')
    for (const state of ['loading', 'error', 'no-permission', 'read-only', 'drill-none', 'drill-failed', 'drill-dialog', 'tf-ask', 'tf-lockout', 'tf-step-up']) expect(ids).toContain(state)
  })
  const added = (screen: DesignScreen<unknown>, prefix: RegExp) => ({ ...screen, cases: screen.cases.filter((item) => prefix.test(item.id)) }) as DesignScreen<unknown>
  for (const screen of [designScreen as DesignScreen<unknown>, added(rolesScreen as DesignScreen<unknown>, /two-factor|role-rules/), added(overviewScreen as DesignScreen<unknown>, /attention/)]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        expect(screen.cases.length).toBeGreaterThan(3)
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the role record says why a ready-made role keeps two-factor, and the security page why a box is held', () => {
    const drawn = render(rolesScreen as DesignScreen<unknown>, rolesScreen.cases.find((item) => item.id === 'role-two-factor-fixed')!.model, 'en')
    expect(drawn).toContain('The ready-made role always asks for it')
    const security = render(designScreen as DesignScreen<unknown>, designScreen.cases.find((item) => item.id === 'error')!.model, 'en')
    expect(security).toContain('Status not available')
    expect(security).not.toContain('Every part is working')
  })
})

/** One cell as the grid would draw it: its renderer with the row, or the text its value getter gives. */
function cellNode<T>(column: ColDef<T>, row: T): ReactNode {
  const renderer = column.cellRenderer
  if (renderer && typeof renderer !== 'string') return createElement(renderer as ComponentType<Record<string, unknown>>, { data: row, value: undefined })
  const value = typeof column.valueGetter === 'function' ? column.valueGetter({ data: row } as never) : undefined
  return value === null || value === undefined ? '' : String(value)
}

describe('the lists’ cells, drawn alone', () => {
  const drill: Drill = { id: 'd', drilledOn: '2026-10-29', environment: 'staging', backupAt: '2026-10-29T02:00:00.000Z', result: 'FAILED', durationMinutes: 12, notes: null, checks: [{ key: 'orders', source: 'a', restored: 'b', match: false }], evidenceFileId: null, performedBy: { id: 'u', name: 'Anna Esempio' }, createdAt: '2026-10-29T16:00:00.000Z' }
  const item: AttentionItem = { kind: 'tabletUnseen', subject: 'Taglio 2', state: null, since: '2026-10-26T15:40:00.000Z', count: null, days: 3, href: '/admin/devices/x', severity: 'warning' }
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      const t = createTranslator(locale, words(locale))
      const words2 = { name: (value: { key: string; name: string }) => value.name }
      const nodes: ReactNode[] = [
        ...twoFactorColumns({ t, prefix: '/w/DEMO', words: words2 }).map((column) => cellNode(column, role({ holders: [{ userId: 'u', name: 'Marco Prova', twoFactor: false }], lock: 'template' }))),
        ...drillColumns({ t, locale }).map((column) => cellNode(column, drill)),
        ...attentionColumns({ t, locale, prefix: '/w/DEMO' }).map((column) => cellNode(column, item)),
      ]
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', NAMESPACE]) }, ...nodes))
      expect(html.match(LEFT_KEY)?.[0] ?? null).toBeNull()
      expect(html).toContain('Marco Prova')
      expect(html).toContain('Taglio 2')
      for (const kind of ATTENTION_KINDS) expect(attentionWords({ ...item, kind, state: kind === 'drill' ? 'overdue' : null, count: 2 }, t, locale)).not.toMatch(LEFT_KEY)
    })
  }
})
