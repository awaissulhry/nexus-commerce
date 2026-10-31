import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE, messagesFor, placeholdersOf } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { designScreen as companiesScreen } from './companies/fixtures'
import { ISSUE_FIELDS, REGIMES } from './companies/model'
import { designScreen as devicesScreen } from './devices/fixtures'
import { DEVICE_TILES } from './devices/model'
import { designScreen as overviewScreen } from './overview/fixtures'
import { READ_RIGHTS, STEP_IDS } from './overview/model'
import { designScreen as rolesScreen } from './roles/fixtures'
import { ALWAYS_RULES } from './roles/model'
import { DEVICE_KINDS, DEVICE_NETWORKS, DEVICE_STATUSES, GRAINS, PRINTER_KINDS, PRINTER_STATUSES, SITE_KINDS, USER_STATUSES, WORK_CENTRE_KINDS, WORKER_STATUSES } from './shared/api'
import { permissionKey } from './shared/view/PermissionMatrix'
import { designScreen as sitesScreen } from './sites/fixtures'
import { designScreen as usersScreen } from './users/fixtures'
import { FLOOR_LOCALES, FLOOR_TILES, OFFICE_TILES } from './users/model'
import { designScreen as recordScreen } from './users/record/fixtures'

/**
 * Every Admin string exists in it and en (PLAN §4.6, PLT-127): the same keys and placeholders, every key the code names
 * (literally, or built from an enum), a sentence for every permission of the platform, and every design case of SCR-008
 * to SCR-013 and SCR-165 drawn in both languages with no message key left on screen (as `/design` first draws them).
 * The lists' cells are drawn by AG Grid in a browser only: admin-lists.vitest.test.ts draws each cell alone.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url))
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })

const PREFIXES = ['common', 'problem', 'stepUp', 'list', 'record', 'noAccess', 'grains', 'scope', 'reveal', 'matrix', 'form', 'held', 'right', 'nav', 'status', 'overview', 'org', 'company', 'site', 'users', 'user', 'worker', 'roles', 'role', 'devices', 'device', 'printers', 'area']
/** Strings shaped like keys that are not: the permissions the code names. */
const NOT_KEYS: ReadonlySet<string> = new Set<string>(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name))

function literalKeys(): string[] {
  const pattern = new RegExp(`['"\`]((?:${PREFIXES.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
  const keys = new Set<string>()
  for (const file of sources(SRC)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) if (!NOT_KEYS.has(match[1]!)) keys.add(match[1]!)
  return [...keys].sort()
}

const admin = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale].admin ?? {}
const has = (key: string) => LOCALES.every((locale) => key in admin(locale) || (`${key}_one` in admin(locale) && `${key}_other` in admin(locale)))

const built = [
  ...['ACTIVE', 'ARCHIVED'].map((status) => `status.${status}`),
  ...['COMPANY', ...SITE_KINDS].map((kind) => `org.kind.${kind}`),
  ...ISSUE_FIELDS.map((field) => `org.issue.${field}`),
  ...['none', ...REGIMES].map((regime) => `company.regime.${regime}`),
  ...WORK_CENTRE_KINDS.map((kind) => `site.centreKind.${kind}`),
  ...['line', 'station', 'centre'].flatMap((kind) => [`site.dialog.${kind}.title`, `site.dialog.${kind}.hint`, `site.dialog.${kind}.create`, `site.done.${kind}`]),
  ...['sites', 'lines', 'stations', 'devices', 'printers', 'other'].map((kind) => `problem.inUseBy.${kind}`),
  ...FLOOR_LOCALES.map((code) => `common.language.${code}`),
  ...Array.from({ length: 12 }, (_, index) => `common.month.${index + 1}`),
  ...GRAINS.flatMap((grain) => [`grains.short.${grain}`, `grains.without.${grain}`]),
  ...USER_STATUSES.map((status) => `users.status.${status}`),
  ...WORKER_STATUSES.map((status) => `users.workerStatus.${status}`),
  ...[...OFFICE_TILES, ...FLOOR_TILES].flatMap((tile) => [`users.tile.${tile}`, `users.tileHint.${tile}`]),
  ...['sent', 'already_sent', 'refused'].map((outcome) => `users.invite.outcome.${outcome}`),
  ...['suspend', 'reactivate', 'deactivate', 'password'].flatMap((action) => ['title', 'body', 'action', 'confirm', 'consequence'].map((part) => `user.${action}.${part}`).concat(`user.done.${action}`)),
  ...['badge', 'pin', 'lost', 'deactivate', 'reactivate'].flatMap((dialog) => ['title', 'body', 'go'].map((part) => `worker.confirm.${dialog}.${part}`)),
  ...['deactivate', 'reactivate'].flatMap((action) => [`worker.${action}.title`, `worker.${action}.body`, `worker.${action}.action`, `worker.done.${action}`]),
  ...['badge', 'pin', 'enrolment'].flatMap((kind) => ['title', 'body', 'qr', 'stored'].map((part) => `reveal.${kind}.${part}`)),
  ...['all', 'office', 'floor'].map((audience) => `roles.audience.${audience}`),
  ...ALWAYS_RULES.flatMap((rule) => [`role.rule.${rule}.title`, `role.rule.${rule}.why`]),
  ...['done', 'needs', 'waiting', 'blocked', 'unknown', 'failed', 'checking'].map((state) => `overview.state.${state}`),
  ...STEP_IDS.map((step) => `overview.step.${step}`),
  ...Object.values(READ_RIGHTS).map((right) => `right.${right.replace(/\./g, '_')}`),
  ...DEVICE_STATUSES.map((status) => `devices.status.${status}`),
  ...DEVICE_KINDS.map((kind) => `devices.kind.${kind}`),
  // B-W2b-24: the network a tablet says it uses.
  ...DEVICE_NETWORKS.map((network) => `devices.network.${network}`),
  ...[...DEVICE_TILES, 'failedPrinters'].map((tile) => `devices.tile.${tile}`),
  ...['where', 'scan', 'ready'].map((step) => `devices.step.${step}`),
  ...PRINTER_KINDS.map((kind) => `printers.kind.${kind}`),
  ...PRINTER_STATUSES.map((status) => `printers.status.${status}`),
  'printers.relay.FAKE',
  ...['suspend', 'reactivate', 'deactivate', 'password', 'default', 'invite', 'workerRoles', 'giveRole', 'endRole', 'badge', 'pin'].map((sentence) => `stepUp.sentence.${sentence}`),
]

describe('every Admin string exists in it and en (PLAN §4.6)', () => {
  it('the same keys and placeholders in every language, no empty text', () => {
    const en = admin('en')
    const itc = admin('it')
    expect(Object.keys(en).length).toBeGreaterThan(900)
    expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(en[key]?.trim(), `en ${key}`).not.toBe('')
      expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
      expect(placeholdersOf(itc[key] ?? ''), `placeholders of ${key}`).toEqual(placeholdersOf(en[key] ?? ''))
    }
  })

  it('every key the Admin code names, literally or from an enum, exists', () => {
    const keys = [...literalKeys(), ...built]
    expect(keys.length).toBeGreaterThan(600)
    expect(keys.filter((key) => !has(key))).toEqual([])
  })

  it('every platform permission and every area has words of its own (the role matrix never falls back to English)', () => {
    const platform = new Set(['companies', 'sites', 'users', 'roles', 'audit', 'numbering', 'files', 'links', 'devices', 'workers', 'floor', 'threads', 'imports', 'documents', 'print', 'email', 'privacy'])
    const definitions = FACTORY_PERMISSIONS.assignable
    expect(definitions.filter((definition) => platform.has(definition.area) && !has(permissionKey(definition.name))).map((definition) => definition.name)).toEqual([])
    expect([...new Set(definitions.map((definition) => definition.area))].filter((area) => !has(`area.${area}`))).toEqual([])
  })

  it('B-W2b-24 (Z12:08): every assignable permission of every area has words of its own in both languages', () => {
    const missing = FACTORY_PERMISSIONS.assignable.filter((definition) => !has(permissionKey(definition.name))).map((definition) => definition.name)
    expect(missing).toEqual([])
  })
})

const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.filter((prefix) => !['status', 'area'].includes(prefix)).join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

const SCREENS = [overviewScreen, companiesScreen, sitesScreen, usersScreen, recordScreen, rolesScreen, devicesScreen] as DesignScreen<unknown>[]

describe('every Admin design case draws in both languages with no key left on screen', () => {
  it('the screens are SCR-008 to SCR-013 and SCR-165, with every state', () => {
    expect(SCREENS.map((screen) => screen.screen).sort()).toEqual(['SCR-008', 'SCR-009', 'SCR-010', 'SCR-011', 'SCR-012', 'SCR-013', 'SCR-165'])
    expect(SCREENS.reduce((sum, screen) => sum + screen.cases.length, 0)).toBeGreaterThan(120)
    // Every list screen has its loading and its failed state; every record its not-found one.
    for (const screen of [companiesScreen, sitesScreen, usersScreen, recordScreen, rolesScreen, devicesScreen] as DesignScreen<unknown>[]) {
      const ids = screen.cases.map((item) => item.id).join(' ')
      expect(ids, screen.screen).toMatch(/loading/)
      expect(ids, screen.screen).toMatch(/not-found|error/)
    }
  })

  for (const screen of SCREENS) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('F1 on the site: a switch for who may change it, the state in words with the right it needs for who may not', () => {
    const draw = (id: string) => render(sitesScreen as DesignScreen<unknown>, sitesScreen.cases.find((item) => item.id === id)!.model, 'en')
    const on = draw('calendars-badge-on')
    expect(on).toContain('Badge alone starts work')
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/)
    expect(draw('calendars')).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/)
    const held = draw('calendars-badge-held')
    expect(held).toContain('Needs the right: Enrol and change floor devices')
    expect(held).not.toMatch(/role="switch"/)
    expect(draw('calendars')).not.toContain('Coming with the floor step')
  })
})
