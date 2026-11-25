import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { CATALOGUE } from '../i18n/messages'
import { render, textOf } from '../record-thread/parts/testing'
import { DOCK_WIDTHS } from '../record-thread/head/model'
import { defaultWidthAt, DOCK_COLUMNS, DOCK_FROM, FRAME_NS, frameMode, isThreadKey, PHONE_BELOW, THIRD_BELOW } from './model'
import { RecordNotices } from './RecordNotices'
// The portal frame's names, read from a test only (the guard exempts tests): they must BE the core's (O2-B3).
import { DEFAULT_PORTAL_DOCK_WIDTH, isPortalThreadKey, PORTAL_DOCK_COLUMNS, PORTAL_DOCK_COLUMNS_OF, PORTAL_DOCK_FROM, PORTAL_DOCK_WIDTHS, portalFrameMode } from '../../portal/shell/record/model'

/**
 * pp-k1 k1.2 / k1.3 — the record frame's CORE (lib/record-frame): the dock geometry, ⌘J, the frame's catalogue and the ONE notice,
 * shared by the office frame (areas/_shared/record-frame/RecordFrame.tsx) and the portal's (portal/shell/record/PortalRecordFrame.tsx).
 *   - the wall (O2-B1: the view-boundary guard does not see lib → areas): no file of the core imports a view's folder — areas/ (the
 *     office) or portal/ (the portal), nor app/, shell/, links/ or floor/ — nor the API client; nothing is left at the old address;
 *   - O2-B3: the portal frame kept a declared copy of the office's numbers and nothing pinned them equal. Its names are the core's
 *     own values now, and its model holds no number of its own; it keeps its three widths (no `full`);
 *   - the one notice moved with its stylesheet, loaded where it stood (the cascade an office page has is the same).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(HERE, '..', '..')
const read = (fromSrc: string): string => readFileSync(join(SRC, fromSrc), 'utf8')
/** Every file of the core but its tests, as a path from its folder. */
const FILES = (readdirSync(HERE, { recursive: true, withFileTypes: false }) as string[]).map((file) => file.split('\\').join('/')).filter((file) => /\.(tsx?|css)$/.test(file) && !file.includes('.vitest.'))
const CODE = FILES.filter((file) => /\.tsx?$/.test(file))
/** What a file imports, as written. */
const importsOf = (text: string): string[] => [...text.matchAll(/(?:\bfrom|\bimport)\s+'([^']+)'|\bimport\('([^']+)'\)/g)].map((match) => match[1] ?? match[2]!)
/** A relative import as a path from src/ (as written, no extension added); a package stays as written. */
const fromSrc = (file: string, path: string): string => (path.startsWith('.') ? relative(SRC, resolve(dirname(join(HERE, file)), path)).split('\\').join('/') : path)

describe('the core knows no page: it imports nothing from areas/ or portal/ (O2-B1)', () => {
  it('the folder holds the geometry, the one notice and its stylesheet; nothing is left at the office address', () => {
    expect(relative(SRC, HERE).split('\\').join('/').replace(/\/$/, '')).toBe('lib/record-frame')
    for (const file of ['model.ts', 'RecordNotices.tsx', 'record-notices.css']) expect(FILES, file).toContain(file)
    expect(existsSync(join(SRC, 'areas', '_shared', 'record-frame', 'RecordNotices.tsx'))).toBe(false)
    // The office frame keeps its host (RecordFrame.tsx stays in areas/_shared/record-frame: a later job makes ONE frame).
    expect(existsSync(join(SRC, 'areas', '_shared', 'record-frame', 'RecordFrame.tsx'))).toBe(true)
  })

  it('no file imports a view\'s folder (areas/, portal/, app/, shell/, links/, floor/), the API client or the session; none fetches', () => {
    expect(CODE.length).toBeGreaterThanOrEqual(2)
    for (const file of CODE) {
      const text = readFileSync(join(HERE, file), 'utf8')
      for (const path of importsOf(text)) {
        const target = fromSrc(file, path)
        expect(target, `${file} imports ${path}`).not.toMatch(/^(?:areas|portal|app|shell|links|floor)(?:\/|$)/)
        expect(target, `${file} imports ${path}`).not.toMatch(/^lib\/(?:api|session)(?:\/|$)/)
      }
      expect(text, file).not.toContain('fetch(')
    }
    // The geometry is pure: a type from the dock's widths, nothing else.
    expect(importsOf(read('lib/record-frame/model.ts'))).toEqual(['../record-thread/head/model'])
    expect(importsOf(read('lib/record-frame/RecordNotices.tsx')).sort()).toEqual(['../../record-panels/i18n', '../i18n/provider', './model', './record-notices.css', '@nexus/ui/primitives', 'lucide-react', 'react'].sort())
  })
})

describe('the geometry: the office frame\'s numbers, now in one place', () => {
  it('docked from 1280 px, a third under 1600 px on a grid tab, the phone below 720 px; the frame\'s catalogue in both languages', () => {
    expect(DOCK_FROM).toBe(1280)
    expect(THIRD_BELOW).toBe(1600)
    expect(PHONE_BELOW).toBe(720)
    expect([frameMode(1280), frameMode(1279)]).toEqual(['docked', 'stacked'])
    expect(FRAME_NS).toBe('record-frame')
    for (const locale of LOCALES) expect(CATALOGUE[locale][FRAME_NS]?.['notices.more_other'], locale).toBeTruthy()
  })

  it('the office\'s first-width rule is the core\'s (the portal\'s dock reads it next, L8): a third under 1600 px, 40 % from 1600', () => {
    expect([1280, 1440, 1599].map((viewport) => defaultWidthAt('grid', viewport))).toEqual(['third', 'third', 'third'])
    expect([1600, 1920].map((viewport) => defaultWidthAt('grid', viewport))).toEqual(['forty', 'forty'])
    expect(defaultWidthAt('half', 1440)).toBe('half')
  })
})

describe('O2-B3 — the portal frame reads the core: its columns, its dock width and its ⌘J ARE the office\'s', () => {
  it('the same values: where it docks, how it splits (each of its widths), the 40 % column, the mode and the key', () => {
    expect(PORTAL_DOCK_FROM).toBe(DOCK_FROM)
    for (const width of PORTAL_DOCK_WIDTHS) expect(PORTAL_DOCK_COLUMNS_OF[width], width).toBe(DOCK_COLUMNS[width])
    expect(PORTAL_DOCK_COLUMNS).toBe(DOCK_COLUMNS.forty)
    expect(portalFrameMode).toBe(frameMode)
    expect(isPortalThreadKey).toBe(isThreadKey)
  })

  it('the portal keeps three of the office\'s widths, in its order — no `full` (a portal record page keeps its body)', () => {
    expect([...PORTAL_DOCK_WIDTHS]).toEqual(DOCK_WIDTHS.filter((width) => width !== 'full'))
    expect([...PORTAL_DOCK_WIDTHS]).toEqual(['third', 'forty', 'half'])
    expect(Object.keys(PORTAL_DOCK_COLUMNS_OF).sort()).toEqual([...PORTAL_DOCK_WIDTHS].sort())
    expect(PORTAL_DOCK_WIDTHS).toContain(DEFAULT_PORTAL_DOCK_WIDTH)
  })

  it('the portal model holds no copy: no number of the geometry, no column of its own, no key test of its own', () => {
    const portal = read('portal/shell/record/model.ts')
    expect(portal).toContain("from '../../../lib/record-frame/model'")
    expect(portal).not.toMatch(/minmax\(/)
    expect(portal).not.toMatch(/=\s*(?:1280|720|1600)\b/)
    expect(portal).not.toMatch(/'docked'\s*\|\s*'stacked'/)
    expect(portal).not.toMatch(/toLowerCase\(\)\s*===\s*'j'/)
    expect(portal).not.toMatch(/\b(?:PORTAL_PHONE_BELOW|portalThreadPixels)\b/)
    // The office model holds none of the core's declarations either (one place for each).
    const office = read('areas/_shared/record-frame/model.ts')
    for (const name of ['DOCK_FROM', 'THIRD_BELOW', 'PHONE_BELOW', 'FrameMode', 'frameMode', 'DockDefault', 'defaultWidthAt', 'DOCK_COLUMNS', 'threadPixels', 'isThreadKey', 'FRAME_NS']) {
      expect(office, name).not.toMatch(new RegExp(`export (?:const|function|type) ${name}\\b`))
    }
    expect(read('areas/_shared/record-frame/RecordFrame.tsx')).not.toMatch(/export const FRAME_NS\b/)
  })
})

describe('the one notice moved with its stylesheet (B-TH-214; the same cascade on every office record page)', () => {
  it('one notice shows, the others wait in the list: the same markup as before the move', () => {
    const html = render(createElement(RecordNotices, null, createElement('div', { className: 'nds-banner' }, 'First'), createElement('div', { className: 'nds-banner' }, 'Second')))
    expect(html).toContain('<div class="fw-rcf-notices"><div class="fw-rcf-notices-list"><div class="nds-banner">First</div><div class="nds-banner">Second</div></div></div>')
    expect(textOf(html)).toContain('First')
  })

  it('its rules live in record-notices.css alone, tokens only; RecordNotices loads them, and the office frame loads them right after its own', () => {
    const css = read('lib/record-frame/record-notices.css')
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((match) => match[1]!.trim())
    expect(selectors).toEqual(['.fw-rcf-notices', '.fw-rcf-notices:not(:has(> .fw-rcf-notices-list > *))', '.fw-rcf-notices-list', '.fw-rcf-notices:not(.is-open) .fw-rcf-notices-list > :not(:first-child)', '.fw-rcf-notices-more'])
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|color-mix\(/)
    // The office frame's stylesheet keeps no notice rule (one place for each).
    expect(read('areas/_shared/record-frame/record-frame.css')).not.toMatch(/\.fw-rcf-notices[^{]*\{/)
    expect(read('lib/record-frame/RecordNotices.tsx')).toContain("import './record-notices.css'")
    // The office RecordFrame loads the notices' rules right after its own stylesheet, where the block stood in it.
    const frame = read('areas/_shared/record-frame/RecordFrame.tsx')
    expect(frame).toMatch(/import '\.\/record-frame\.css'\n(?:\/\/[^\n]*\n)*import '\.\.\/\.\.\/\.\.\/lib\/record-frame\/record-notices\.css'\n/)
  })
})
