import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../lib/design/design-screen'
import { LOCALES } from '../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../lib/i18n/messages'
import { I18nProvider } from '../lib/i18n/provider'
import { designScreen as enrolScreen } from './enrol/fixtures'
import { designScreen as homeScreen } from './home/fixtures'
import { FLOOR_MODES, TILE_KEYS } from './model'
import { designScreen as noticeScreen } from './notice/fixtures'
import { WHAT_KEYS } from './queue/actions'
import { designScreen as syncScreen } from './queue/fixtures'
import { REFUSAL_WORDS } from './queue/view/SyncView'
import { SCAN_ID_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { LABEL_TYPES } from './scan/scan-model'
import { designScreen as scanScreen } from './scan/fixtures'
import { designScreen as signInScreen } from './sign-in/fixtures'

/**
 * The floor screens' strings (PLAN §4.6, PLT-127): every key the floor code names literally, or builds from a list,
 * exists in it and en; every design case of SCR-020, 021, 022, 024 and 025 draws in both languages with no key left on
 * screen and no secret (a PIN, a badge code) anywhere in its markup.
 */

const DIR = fileURLToPath(new URL('.', import.meta.url))
const APP = fileURLToPath(new URL('../app/(floor)', import.meta.url))

// The floor tasks (floor/tasks/**) speak their own catalogues (floor-tasks, floor-scans …): tasks/tasks.vitest.test.ts holds them.
const TASKS = join(DIR, 'tasks')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return path === TASKS ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && !entry.name.endsWith('fixtures.ts') ? [path] : []
  })
}

const PREFIXES = ['brand', 'frame', 'mode', 'start', 'enrol', 'signIn', 'notice', 'home', 'tile', 'scan', 'label', 'labelPlural', 'status', 'sync']
const literalKeys = () => {
  const pattern = new RegExp(`\\bt\\(\\s*'((?:${PREFIXES.join('|')})(?:\\.[A-Za-z0-9_]+)*)'`, 'g')
  const keys = new Set<string>()
  for (const file of [...sources(DIR), ...sources(APP)]) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
  for (const file of sources(DIR)) for (const match of readFileSync(file, 'utf8').matchAll(/(?:store\.)?frame\('([a-zA-Z.]+)'/g)) keys.add(match[1]!)
  return [...keys].sort()
}

const built = [
  ...[...FLOOR_MODES, 'none'].map((mode) => `mode.${mode}`),
  ...[...FLOOR_MODES, 'none'].map((mode) => `home.scan.hint.${mode}`),
  ...TILE_KEYS.map((key) => `tile.${key}`),
  ...['notice', 'coming'].map((held) => `tile.held.${held}`),
  ...LABEL_TYPES.flatMap((type) => [`label.${type}`, `labelPlural.${type}`]),
  ...['otherFactory', 'typo', 'notFound', 'badge'].flatMap((reason) => [`scan.unknown.${reason}.title`, `scan.unknown.${reason}.body`]),
  ...['codeInvalid', 'offline', 'unavailable', 'rateLimited'].flatMap((problem) => [`enrol.problem.${problem}.title`, `enrol.problem.${problem}.body`]),
  ...['ok', 'missing', 'waiting', 'untested'].map((status) => `enrol.checks.status.${status}`),
  ...['available', 'installed', 'manual'].map((app) => `enrol.install.app.${app}`),
  ...['kept', 'notKept', 'unknown'].map((storage) => `enrol.install.storage.${storage}`),
  ...[1, 2, 3, 4].map((n) => `enrol.kiosk.step${n}`),
  ...['wrong', 'rateLimited', 'unavailable', 'operatorActive', 'pinNeeded'].map((problem) => `signIn.problem.${problem}`),
  ...['idle', 'self', 'ended'].map((why) => `signIn.signedOut.${why}`),
  ...['current', 'new', 'repeat'].map((stage) => `signIn.change.${stage}`),
  ...['mismatch', 'refused', 'wrong', 'repeat', 'run'].map((problem) => `signIn.change.problem.${problem}`),
  'frame.pending',
  'frame.idle.seconds',
  // B-W0-30: the queue's words built from lists.
  ...[...WHAT_KEYS, 'other'].map((key) => `sync.what.${key}`),
  ...REFUSAL_WORDS.flatMap((code) => [`sync.refusal.${code}.message`, `sync.refusal.${code}.fix`]),
  ...SCAN_ID_KINDS.map((kind) => `sync.numbers.kind.${kind}`),
  ...['receive', 'inspect', 'serials'].map((held) => `home.offline.held.${held}`),
  ...['signedOut', 'unavailable'].map((problem) => `sync.problem.${problem}`),
  ...['kept', 'low', 'mayClear'].map((storage) => `sync.storage.${storage}`),
  ...['ahead', 'behind'].map((way) => `sync.clock.${way}`),
  ...['left', 'lowOnline', 'lowOffline'].map((words) => `sync.numbers.${words}`),
]

const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale].floor ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every floor string exists in it and en', () => {
  it('names only keys of the floor catalogue', () => {
    const keys = [...literalKeys(), ...built]
    expect(keys.length).toBeGreaterThan(200)
    expect(keys.filter((key) => !has(key))).toEqual([])
  })
})

const SCREENS = [enrolScreen, signInScreen, homeScreen, syncScreen, scanScreen, noticeScreen] as DesignScreen<unknown>[]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${PREFIXES.filter((prefix) => prefix !== 'brand').join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['floor']) }, createElement(View, { model })))
}

describe('every floor design case draws in both languages', () => {
  it('has the floor screens of B-W0-29 and B-W0-30', () => {
    expect(SCREENS.map((screen) => screen.screen)).toEqual(['SCR-020', 'SCR-021', 'SCR-022', 'SCR-023', 'SCR-024', 'SCR-025'])
  })

  for (const screen of SCREENS) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases, no key left, no secret`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          // No six-digit run (a PIN) and no badge-shaped code in any screen's markup.
          // (A label code's reference, `HD-7K-000009-M`, sits between hyphens; 123456 is the rules' example of a PIN refused.)
          const text = html.replace(/<[^>]+>/g, ' ').replaceAll('123456', '')
          expect(text.match(/(?<![-\w])\d{6}(?![-\w])|\b[0-9A-HJKMNP-TV-Z]{26}\b/)?.[0] ?? null, `${screen.screen}/${item.id}`).toBeNull()
        }
      })
    }
  }

  it('the badge step takes scans only, the PIN pad shows dots only', () => {
    const badge = render(signInScreen as DesignScreen<unknown>, signInScreen.cases.find((item) => item.id === 'badge')!.model, 'en')
    expect(badge).toContain('Scan your badge')
    expect(badge).toContain('inputMode="none"')
    const pin = render(signInScreen as DesignScreen<unknown>, signInScreen.cases.find((item) => item.id === 'pin-badge')!.model, 'it')
    expect(pin).toContain('0 di 6')
    expect(pin).not.toContain('<input')
  })

  it('held tiles say why on the tile; the floor tasks and Scan anything open', () => {
    const cutting = render(homeScreen as DesignScreen<unknown>, homeScreen.cases.find((item) => item.id === 'cutting')!.model, 'en')
    expect(cutting).not.toContain('Coming soon')
    expect(cutting).toContain('Scan anything')
    const html = render(homeScreen as DesignScreen<unknown>, homeScreen.cases.find((item) => item.id === 'packing')!.model, 'en')
    expect(html.match(/Coming soon/g)?.length).toBeGreaterThanOrEqual(2)
    const held = render(homeScreen as DesignScreen<unknown>, homeScreen.cases.find((item) => item.id === 'notice-blocks')!.model, 'en')
    expect(held).toContain('Read the notice first')
    expect(held).not.toContain('Coming soon')
  })

  it('the queue shows refused actions in the person\'s words with one fix, and others\' counted, never shown', () => {
    const refused = render(syncScreen as DesignScreen<unknown>, syncScreen.cases.find((item) => item.id === 'refused')!.model, 'it')
    expect(refused).toContain('Rifiutate, con la soluzione')
    expect(refused).toContain('Scartala e scansiona il cartellino nuovo.')
    expect(refused).toContain('la vede il capo squadra')
    const detail = render(syncScreen as DesignScreen<unknown>, syncScreen.cases.find((item) => item.id === 'discard-offline')!.model, 'en')
    expect(detail).toContain('Needs the network')
    const offline = render(homeScreen as DesignScreen<unknown>, homeScreen.cases.find((item) => item.id === 'held-network')!.model, 'en')
    expect(offline).toContain('inspections and releases wait for the network')
    const waiting = render(homeScreen as DesignScreen<unknown>, homeScreen.cases.find((item) => item.id === 'queue-offline-pending')!.model, 'en')
    expect(waiting).toContain('Open queue')
  })
})
