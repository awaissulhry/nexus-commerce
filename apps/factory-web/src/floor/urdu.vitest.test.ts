import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FloorActionBar, FloorList, FloorListRow } from '@nexus/ui/floor'
import { FloorWords } from '../lib/floor-words/FloorWords'
import { FloorWordsProvider } from '../lib/floor-words/provider'
import { baseLocaleOf, dirOf, FLOOR_LOCALES, floorLocaleOf, LOCALES } from '../lib/i18n/locales'
import { CATALOGUE, messagesFor, URDU } from '../lib/i18n/messages'
import { I18nProvider } from '../lib/i18n/provider'
import { BasketDock } from './basket/dock/BasketDock'
import { basketRead } from './basket/fixtures'
import { deptOf, dockOf, stepBarOf, viewOf } from './basket/model'
import { STITCHING } from './basket/fixtures'
import { floorLocale, floorLocalesOf } from './model'
import { FLOOR_NAMESPACES } from './tasks/routes'

/**
 * owb-fl7 (pick J) — Urdu and right to left on the floor (written, run at the end: Owner rule). Urdu is a floor language only, OFF per
 * site until the site lists it (an Urdu worker notice in force); check-i18n allows `ur` for the floor's catalogues alone, warns for a
 * missing Urdu key and stays strict for Italian and English; a missing key shows in English; the floor frame reads right to left and
 * the office never sets a direction; codes stay in <bdi>; the Urdu word stands above its small English word; the design system's
 * reused floor parts carry no physical left / right (the two that point the reading way are turned from outside: named in the notes).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..')
const ROOT = join(SRC, '../../..')

// fl8's help parts read the floor app: a page drawn alone draws their places empty.
vi.mock('./basket/help', () => ({ HELP_READY: false, ProblemTile: () => null, AskTile: () => null, PhotoTile: () => null, NotesTile: () => null, AskWindow: () => null, ProblemCard: () => null, AskCard: () => null }))

describe('the floor languages', () => {
  it('Urdu is the floor\'s only: LOCALES stay Italian and English; FLOOR_LOCALES add Urdu', () => {
    expect([...LOCALES]).toEqual(['it', 'en'])
    expect([...FLOOR_LOCALES]).toEqual(['it', 'en', 'ur'])
    expect(floorLocaleOf('ur-PK')).toBe('ur')
    expect(baseLocaleOf('ur')).toBe('en')
  })

  it('floorLocale takes Urdu only where the SITE lists it (an Urdu worker notice in force)', () => {
    expect(floorLocale({ person: 'ur', tenant: 'it' })).toBe('it')
    expect(floorLocale({ person: 'ur', tenant: 'it', site: ['it', 'en'] })).toBe('it')
    expect(floorLocale({ person: 'ur', tenant: 'it', site: ['it', 'en', 'ur'] })).toBe('ur')
    expect(floorLocale({ picked: 'ur', tenant: 'en', site: ['en'] })).toBe('en')
    expect(floorLocalesOf(['it', 'ur'])).toEqual(['it', 'en', 'ur'])
    expect(floorLocalesOf(null)).toEqual(['it', 'en'])
  })

  it('a key Urdu lacks shows in English; Urdu files exist only for floor catalogues', () => {
    const words = messagesFor('ur', ['floor-basket', 'floor'])
    expect(words['floor-basket']!['dock.start']).toBe(URDU['floor-basket']!['dock.start'])
    expect(words.floor!['frame.openQueue']).toBe(CATALOGUE.en.floor!['frame.openQueue'])
    for (const namespace of Object.keys(URDU)) expect(FLOOR_NAMESPACES, namespace).toContain(namespace)
  })
})

describe('right to left', () => {
  it('Urdu reads right to left; Italian and English left to right', () => {
    expect(dirOf('ur')).toBe('rtl')
    expect(dirOf('it')).toBe('ltr')
    expect(dirOf('en-GB')).toBe('ltr')
  })

  it('the floor app sets the direction (and takes it away when it leaves); the office never sets one', () => {
    const floorApp = readFileSync(join(HERE, 'FloorApp.tsx'), 'utf8')
    expect(floorApp).toContain('html.dir = dirOf(spoken)')
    expect(floorApp).toContain("html.removeAttribute('dir')")
    const office = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? office(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []))
    for (const file of [...office(join(SRC, 'shell')), ...office(join(SRC, 'app/(office)'))]) {
      const text = readFileSync(file, 'utf8')
      expect(/\.dir\s*=|setAttribute\(\s*'dir'/.test(text), file).toBe(false)
    }
  })

  it('codes stay in <bdi>; the dock\'s words are the Urdu word above its small English word', () => {
    const view = viewOf(basketRead({ work: { state: 'WORKING', mine: true } }))!
    const dock = dockOf({ view, scanned: false, leader: false, designPending: false, stepsReady: true, quality: null })
    const html = renderToString(
      createElement(FloorWordsProvider, { locale: 'ur' }, createElement(I18nProvider, { locale: 'en', messages: messagesFor('ur', ['floor', 'floor-basket']) }, createElement(BasketDock, { model: { dock, next: deptOf(STITCHING, 'ur'), here: null, canAsk: false, busy: false, problem: null }, onAction: () => undefined }))),
    )
    expect(html).toContain(URDU['floor-basket']!['dock.done']!)
    expect(html).toContain('lang="en" dir="ltr">Done<')
    expect(stepBarOf(view, 'ur').now?.dept?.no).toBe(4)
  })

  it('the two-line label draws one word when the English is the same or missing', () => {
    expect(renderToString(createElement(FloorWords, { words: 'B-0431', english: 'B-0431' }))).not.toContain('fw-fwords')
    expect(renderToString(createElement(FloorWords, { words: 'شروع کریں', english: 'Start' }))).toContain('fw-fwords-sub')
  })
})

describe('the design system\'s floor parts, right to left (packages/ui is frozen: a break is named, never edited)', () => {
  const UI = join(ROOT, 'packages/ui/src')
  const physical = /(margin|padding|border)-(left|right)\b|(^|[^-\w])(left|right)\s*:|text-align:\s*(left|right)|float:\s*(left|right)/m

  it('their stylesheets use logical properties only (FloorActionBar, FloorListRow, ReasonGrid, QuantityPad, PinPad, the Modal sheet)', () => {
    for (const file of ['floor/floor.css', 'floor/ReasonGrid/reasonGrid.css', 'floor/QuantityPad/quantityPad.css', 'components/modalSheet.css']) {
      expect(physical.test(readFileSync(join(UI, file), 'utf8')), file).toBe(false)
    }
  })

  it('the two icons that point the reading way (the reason grid\'s pager, the pads\' backspace) are turned by floor.css', () => {
    expect(readFileSync(join(UI, 'floor/ReasonGrid/ReasonGrid.tsx'), 'utf8')).toMatch(/ChevronLeft|ChevronRight/)
    const css = readFileSync(join(HERE, 'floor.css'), 'utf8')
    expect(css).toContain(".nds-floor-reasons-pager .lucide-chevron-left")
    expect(css).toContain('.lucide-delete')
    expect(css).toContain(':lang(ur)')
  })

  it('FloorActionBar and FloorListRow draw inside a right-to-left page with no direction of their own', () => {
    const html = renderToString(
      createElement('div', { dir: 'rtl' }, createElement(FloorActionBar, { actions: [{ label: 'شروع کریں', onPress: () => undefined }] }), createElement(FloorList, { label: 'ٹوکریاں', children: createElement(FloorListRow, { icon: null, title: 'B-0431' }) })),
    )
    expect(html).not.toMatch(/dir="ltr"/)
    expect(html).toContain('nds-floor-actionbar')
  })
})

describe('check-i18n: Urdu for the floor only, a missing Urdu key warns, Italian and English strict', () => {
  const SCRIPT = join(ROOT, 'scripts/factory/check-i18n.mjs')

  /** A small tree the script reads (CHECK_I18N_ROOT): the two locale lists, the floor's catalogues, the files. */
  function tree(files: Readonly<Record<string, unknown>>): string {
    const root = mkdtempSync(join(tmpdir(), 'check-i18n-'))
    const web = join(root, 'apps/factory-web')
    mkdirSync(join(web, 'src/lib/i18n'), { recursive: true })
    mkdirSync(join(web, 'src/floor/tasks'), { recursive: true })
    writeFileSync(join(web, 'src/lib/i18n/locales.ts'), "export const LOCALES = ['it', 'en'] as const\nexport const FLOOR_LOCALES = ['it', 'en', 'ur'] as const\n")
    writeFileSync(join(web, 'src/floor/tasks/routes.ts'), "export const FLOOR_NAMESPACES = ['floor', /* a comment */ 'floor-basket'] as const\n")
    for (const [path, value] of Object.entries(files)) {
      const file = join(web, 'messages', path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, JSON.stringify(value))
    }
    return root
  }
  const run = (root: string) => {
    const answer = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, CHECK_I18N_ROOT: root }, encoding: 'utf8' })
    rmSync(root, { recursive: true, force: true })
    return { code: answer.status, out: `${answer.stdout}${answer.stderr}` }
  }
  const base = { 'it/floor.json': { a: 'Ciao', b: 'Fatto {n}' }, 'en/floor.json': { a: 'Hello', b: 'Done {n}' }, 'it/office.json': { x: 'Ufficio' }, 'en/office.json': { x: 'Office' } }

  it('a partial Urdu floor file passes, and its missing keys are a warning', () => {
    const result = run(tree({ ...base, 'ur/floor.json': { a: 'سلام' } }))
    expect(result.code).toBe(0)
    expect(result.out).toContain('warning')
    expect(result.out).toContain('1 of 2 keys')
  })

  it('an Urdu file outside the floor\'s catalogues fails', () => {
    const result = run(tree({ ...base, 'ur/office.json': { x: 'دفتر' } }))
    expect(result.code).toBe(1)
    expect(result.out).toContain('floor language only')
  })

  it('an Urdu key English lacks, or other placeholders, fails', () => {
    expect(run(tree({ ...base, 'ur/floor.json': { z: 'غلط' } })).code).toBe(1)
    expect(run(tree({ ...base, 'ur/floor.json': { b: 'مکمل {m}' } })).code).toBe(1)
  })

  it('Italian and English stay strict: a key one of them lacks fails', () => {
    expect(run(tree({ ...base, 'it/floor.json': { a: 'Ciao' } })).code).toBe(1)
  })
})
