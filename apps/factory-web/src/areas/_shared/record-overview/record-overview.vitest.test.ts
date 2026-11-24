import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../../lib/i18n/locales'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { everyCase, leftKeys, render, textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'
import { GROUP_ROWS_SHOWN, OVERVIEW_NS, STRIPS_SHOWN } from './model'
import { CardState, Headline, Overview, OverviewCard, OverviewPair, useOverviewWords } from './Overview'
import { Strip, StripSaid, Strips } from './Overview' // F-CO-K2: the strips
import { QuietLine, Row, RowList } from './Overview' // F-CO-K2: the ONE list
import { Door, Fact, FactCols } from './Overview' // F-CO-K2: the facts
import { Group, GroupRow, Groups, RowAge } from './Overview' // F-CO-K2: the groups (S32: Groups)
import { LAB_WIDTHS } from './view/OverviewLab'

/**
 * F-CO-K1 (customer overview lane: the shared overview kit) — the kit's own rules, pinned:
 *   - the wall: it imports no page (no order, no party, no purchasing), fetches nothing and speaks only its own catalogue;
 *   - its stylesheet's public contract (the two rooms' names, the shared row, the text rules' order), tokens only, and ONE
 *     stylesheet for the parts;
 *   - each frame part's markup — the markup the order's Overview drew by hand before it moved here;
 *   - its lab: every case draws in both languages with no key left.
 * F-CO-K2: the rows' parts too (the strips, the ONE list, the facts, the groups) and their rules.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** Every file of the kit's folder but its tests, as a path from the folder. */
const FILES = (readdirSync(HERE, { recursive: true, withFileTypes: false }) as string[]).map((file) => file.split('\\').join('/')).filter((file) => /\.(tsx?|css)$/.test(file) && !file.includes('.vitest.'))
const CODE = FILES.filter((file) => /\.tsx?$/.test(file))
const source = (file: string): string => readFileSync(join(HERE, file), 'utf8')
const css = (): string => source('record-overview.css')
/** What a file imports, as written. */
const importsOf = (text: string): string[] => [...text.matchAll(/(?:\bfrom|\bimport)\s+'([^']+)'|\bimport\('([^']+)'\)/g)].map((match) => match[1] ?? match[2]!)
/** A part drawn with NO catalogue handed to the page: what a part says then is what it reads itself. */
const bare = (node: ReactNode, locale: Locale = 'en'): string => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: {} }, node))

describe('the kit knows no page: it imports no order, no party and no purchasing, fetches nothing, speaks only its own catalogue', () => {
  it('the folder holds the parts, their ONE stylesheet, the caps, the lab and its own small stylesheet', () => {
    for (const file of ['Overview.tsx', 'model.ts', 'record-overview.css', 'fixtures.ts', 'view/OverviewLab.tsx', 'view/overview-lab.css']) expect(FILES, file).toContain(file)
    // ONE stylesheet for the parts (the lab's own is beside its view and names no class of the kit).
    expect(FILES.filter((file) => file.endsWith('.css') && !file.startsWith('view/'))).toEqual(['record-overview.css'])
    expect(source('Overview.tsx')).toContain("import './record-overview.css'")
    expect(source('view/overview-lab.css')).not.toMatch(/\.fw-(?:so|ro)-/)
    expect(source('view/overview-lab.css')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })

  it('no file imports from areas/sales, areas/parties or areas/purchasing; none reaches the API client or fetches', () => {
    expect(CODE.length).toBeGreaterThan(3)
    for (const file of CODE) {
      const text = source(file)
      for (const path of importsOf(text)) {
        expect(path, `${file} imports ${path}`).not.toMatch(/(?:^|\/)(?:sales|parties|purchasing)(?:\/|$)/)
        expect(path, `${file} imports ${path}`).not.toMatch(/\/lib\/api(?:\/|$)|\/use-[a-z-]+$/)
      }
      expect(text, file).not.toContain('fetch(')
    }
    // The parts' file itself: the DS, the i18n plumbing, its own model and stylesheet — nothing else.
    // F-CO-K2: + the failed strip's mark (the DS's icon set).
    expect(importsOf(source('Overview.tsx')).sort()).toEqual(['../../../lib/i18n/messages', '../../../lib/i18n/provider', '../../../record-panels/i18n', './model', './record-overview.css', '@nexus/ui/components', '@nexus/ui/primitives', 'lucide-react', 'react'].sort())
    expect(importsOf(source('model.ts'))).toEqual([])
  })

  it('one namespace: record-overview — no part reads the order\'s catalogue or any other', () => {
    expect(OVERVIEW_NS).toBe('record-overview')
    for (const locale of LOCALES) expect(CATALOGUE[locale][OVERVIEW_NS], locale).toBeDefined()
    for (const file of CODE) {
      const text = source(file)
      // Every translator and every catalogue provider names the kit's own namespace, by its constant.
      for (const call of text.match(/\buseT\([^)]*\)/g) ?? []) expect(call, file).toBe('useT(OVERVIEW_NS)')
      for (const given of text.match(/namespaces=\{[^}]*\}/g) ?? []) expect(given, file).toBe('namespaces={[OVERVIEW_NS]}')
      for (const call of text.match(/\bcatalogueFor\([^)]*\)/g) ?? []) expect(call, file).toBe('catalogueFor(locale, OVERVIEW_NS, reader)')
      expect(text, file).not.toMatch(/\buseScopedT\(|\bmessagesFor\(|\buseProductionWords\(/)
      expect(text, file).not.toMatch(/'orders'|'parties'/)
    }
  })

  it('the caps are the kit\'s: four strips before "Show n more", three rows of a group before its door', () => {
    expect([STRIPS_SHOWN, GROUP_ROWS_SHOWN]).toEqual([4, 3])
  })
})

describe('the kit\'s stylesheet: the two rooms, the shared row, the kit\'s own text rules — tokens only', () => {
  it('the public contract: the Overview and every card are named size containers; the pairs; the shared row and its doors', () => {
    const text = css()
    expect(text).toMatch(/\.fw-so-overview \{\s*display: flex;\s*flex-direction: column;\s*gap: var\(--nds-space-16\);\s*min-width: 0;\s*\}/)
    expect(text).toMatch(/\.fw-so-overview \{\s*container: fw-so-ov \/ inline-size;\s*\}/)
    expect(text).toMatch(/\.fw-so-overview > :not\(\.fw-so-ov-pair\),\s*\.fw-so-ov-pair > \* \{\s*container: fw-so-ov-card \/ inline-size;\s*\}/)
    // Only these two rooms are named: a part reads the Overview's width or its card's, never the viewport.
    expect([...text.matchAll(/container: ([a-z-]+) \/ inline-size;/g)].map((match) => match[1])).toEqual(['fw-so-ov', 'fw-so-ov-card'])
    expect(text).not.toMatch(/@media\b/)
    expect(text).toMatch(/@container fw-so-ov \(min-width: 720px\) \{\s*\.fw-so-ov-pair \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
    expect(text).toMatch(/\.fw-so-ov-pair > :only-child \{\s*grid-column: 1 \/ -1;\s*\}/)
    // The shared row: label | value | doors on one baseline; under a 480 px card the doors wrap under the words, to the right.
    expect(text).toMatch(/\.fw-so-ov-row \{\s*display: grid;\s*grid-template-columns: max-content minmax\(0, 1fr\) auto;\s*align-items: baseline;/)
    expect(text).toMatch(/\.fw-so-ov-doors \{\s*display: inline-flex;\s*flex-wrap: wrap;\s*justify-content: flex-end;/)
    expect(text).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{[^@]*\.fw-so-ov-row > \.fw-so-ov-doors \{\s*grid-column: 1 \/ -1;\s*justify-self: end;/)
    expect(text).toMatch(/@container fw-so-ov-card \(min-width: 800px\) \{\s*\.fw-so-ov-cols \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
  })

  it('a card\'s title keeps 12 px above its first row — the rule reads the kit\'s own head and title (the lead card has its column gap)', () => {
    expect(css()).toMatch(/\.fw-so-overview > :not\(\.fw-so-ov-pair, \.fw-so-where\) > :is\(\.fw-ro-head, \.fw-ro-h2\):first-child,\s*\.fw-so-ov-pair > \* > :is\(\.fw-ro-head, \.fw-ro-h2\):first-child \{\s*margin-block-end: var\(--nds-space-12\);\s*\}/)
  })

  it('the text a part draws is the kit\'s own: seven rules, each once; the hint stands before the link; no order text class in the file', () => {
    const text = css()
    for (const rule of ['.fw-ro-head {', '.fw-ro-hint {', "p.fw-ro-hint[role='status'] {", '.fw-ro-link {', '.fw-ro-link:focus-visible {', '.fw-ro-stack {', '.fw-ro-h2 {']) expect(text.split(`\n${rule}`), rule).toHaveLength(2)
    // h2 and h3 share one rule, then each says its size.
    expect(text).toMatch(/\n\.fw-ro-h2,\n\.fw-ro-h3 \{\s*margin: 0;/)
    expect(text.split('\n.fw-ro-h3 {')).toHaveLength(3)
    // An element that carries the link and the hint takes the link's colour: the hint's rule comes first.
    expect(text.indexOf('\n.fw-ro-hint {')).toBeGreaterThan(-1)
    expect(text.indexOf('\n.fw-ro-link {')).toBeGreaterThan(text.indexOf('\n.fw-ro-hint {'))
    expect(text).toMatch(/\.fw-ro-link \{\s*color: var\(--nds-text-link\);/)
    expect(text).toMatch(/\.fw-ro-hint \{\s*margin: 0;\s*color: var\(--nds-text-muted\);/)
    // The order area's text classes are not styled here (the order's own content keeps them, from its own stylesheet).
    expect(text).not.toMatch(/\.fw-so-(?:card-head|h2|h3|hint|link|stack-tight)\b/)
  })

  it('the lead card and its headline; tokens only (no raw colour)', () => {
    const text = css()
    expect(text).toMatch(/\n\.fw-so-where \{\s*display: flex;\s*flex-direction: column;\s*gap: var\(--nds-space-12\);\s*min-width: 0;\s*\}/)
    expect(text).toMatch(/\n\.fw-so-where-said \{\s*display: flex;\s*flex-direction: column;\s*gap: var\(--nds-space-4\);\s*min-width: 0;\s*\}/)
    expect(text).toMatch(/\n\.fw-so-headline \{\s*margin: 0;\s*font-size: var\(--nds-font-size-xl\);\s*font-weight: var\(--nds-font-weight-medium\);\s*overflow-wrap: break-word;\s*\}/)
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})

describe('the frame parts draw the markup the order\'s Overview drew by hand', () => {
  it('Overview: the tab\'s column; OverviewPair: a pair — nothing else around their children', () => {
    expect(render(createElement(Overview, null, 'x'))).toBe('<div class="fw-so-overview">x</div>')
    expect(render(createElement(OverviewPair, null, 'x'))).toBe('<div class="fw-so-ov-pair">x</div>')
  })

  it('OverviewCard: no right side handed over = a bare title; one given, even null = the head row', () => {
    expect(render(createElement(OverviewCard, { title: 'Title' }, 'rows'))).toBe('<div class="nds-card pad"><h2 class="fw-ro-h2">Title</h2>rows</div>')
    expect(render(createElement(OverviewCard, { title: 'Title', aside: null }, 'rows'))).toBe('<div class="nds-card pad"><div class="fw-ro-head"><h2 class="fw-ro-h2">Title</h2></div>rows</div>')
    expect(render(createElement(OverviewCard, { title: 'Title', aside: createElement('a', { href: '#all' }, 'All ›') }, 'rows'))).toBe('<div class="nds-card pad"><div class="fw-ro-head"><h2 class="fw-ro-h2">Title</h2><a href="#all">All ›</a></div>rows</div>')
    // A right side that draws nothing (false) still gives the head row: only `undefined` means "no head row".
    expect(render(createElement(OverviewCard, { title: 'Title', aside: false }, 'rows'))).toBe('<div class="nds-card pad"><div class="fw-ro-head"><h2 class="fw-ro-h2">Title</h2></div>rows</div>')
  })

  it('OverviewCard: the lead card\'s column class, a host\'s test hook after it, busy as aria-busy — and no look prop', () => {
    expect(render(createElement(OverviewCard, { title: 'T', lead: true }))).toBe('<div class="nds-card pad fw-so-where"><h2 class="fw-ro-h2">T</h2></div>')
    expect(render(createElement(OverviewCard, { title: 'T', className: 'fw-xx-hook' }))).toBe('<div class="nds-card pad fw-xx-hook"><h2 class="fw-ro-h2">T</h2></div>')
    expect(render(createElement(OverviewCard, { title: 'T', lead: true, className: 'fw-xx-hook' }))).toBe('<div class="nds-card pad fw-so-where fw-xx-hook"><h2 class="fw-ro-h2">T</h2></div>')
    expect(render(createElement(OverviewCard, { title: 'T', busy: true }))).toBe('<div class="nds-card pad" aria-busy="true"><h2 class="fw-ro-h2">T</h2></div>')
    // The card's props, as written: a title, a right side, lead, busy, a test hook, children — no tone, no size, no variant.
    expect(source('Overview.tsx')).toContain('export function OverviewCard({ title, aside, lead = false, busy = false, className, children }: { title: ReactNode; aside?: ReactNode; lead?: boolean; busy?: boolean; className?: string; children?: ReactNode }): ReactNode {')
  })

  it('Headline: the sentence and its quiet line; null = it is still read (a placeholder, no quiet line)', () => {
    expect(render(createElement(Headline, { sentence: 'In work · Pattern making', quiet: 'Set by the sample room.' }))).toBe('<div class="fw-so-where-said"><p class="fw-so-headline">In work · Pattern making</p><p class="fw-ro-hint">Set by the sample room.</p></div>')
    expect(render(createElement(Headline, { sentence: 'In work' }))).toBe('<div class="fw-so-where-said"><p class="fw-so-headline">In work</p></div>')
    expect(render(createElement(Headline, { sentence: 'In work', quiet: null }))).toBe('<div class="fw-so-where-said"><p class="fw-so-headline">In work</p></div>')
    const reading = render(createElement(Headline, { sentence: null, quiet: 'Set by the sample room.' }))
    expect(reading).toMatch(/^<div class="fw-so-where-said"><span class="nds-skeleton" style="[^"]*"[^>]*><\/span><\/div>$/)
    expect(reading).toContain('width:260px')
    expect(reading).toContain('height:24px')
    // A sentence with no word is still a sentence: only null reads.
    expect(render(createElement(Headline, { sentence: '' }))).toBe('<div class="fw-so-where-said"><p class="fw-so-headline"></p></div>')
  })

  it('CardState: loading says "Loading {part}…" on the kit\'s status line; failed says the part, the page\'s WORDS and Try again when it can', () => {
    const loading = render(createElement(CardState, { part: 'People', problem: null }))
    expect(loading).toMatch(/^<div class="nds-card pad" aria-busy="true"><p class="fw-ro-hint" role="status"><span class="nds-spinner"[^>]*><\/span> Loading People…<\/p><\/div>$/)
    expect(textOf(render(createElement(CardState, { part: 'Persone', problem: null }), 'it'))).toBe('Caricamento di Persone…')
    const failed = render(createElement(CardState, { part: 'People', problem: 'The line is down.', onRetry: () => undefined }))
    expect(failed).toMatch(/^<div class="nds-card pad"><div class="nds-empty"><div class="t">Couldn&#x27;t load People<\/div><div class="d">The line is down\.<\/div><div class="act"><button[^>]*>Try again<\/button><\/div><\/div><\/div>$/)
    expect(failed).not.toContain('aria-busy')
    expect(textOf(render(createElement(CardState, { part: 'Persone', problem: 'La linea è ferma.', onRetry: () => undefined }), 'it'))).toBe('Impossibile caricare Persone La linea è ferma. Riprova')
    // No retry handed over: no button.
    const noRetry = render(createElement(CardState, { part: 'People', problem: 'The line is down.' }))
    expect(noRetry).toBe('<div class="nds-card pad"><div class="nds-empty"><div class="t">Couldn&#x27;t load People</div><div class="d">The line is down.</div></div></div>')
    // The problem is the page's words: the kit never translates it (a text shaped like a key is shown as it is).
    expect(textOf(render(createElement(CardState, { part: 'People', problem: 'state.retry' })))).toBe("Couldn't load People state.retry")
  })

  it('the kit\'s words need no provider: a part says them wherever it is drawn — also beside or above an Overview', () => {
    function Probe(): ReactNode {
      const words = useOverviewWords()
      return createElement('p', null, [words.loading('X'), words.failed('X'), words.retry].join(' | '))
    }
    expect(textOf(bare(createElement(Probe), 'en'))).toBe("Loading X… | Couldn't load X | Try again")
    expect(textOf(bare(createElement(Probe), 'it'))).toBe('Caricamento di X… | Impossibile caricare X | Riprova')
    expect(textOf(bare(createElement(CardState, { part: 'People', problem: null }), 'en'))).toBe('Loading People…')
    expect(textOf(bare(createElement(Overview, null, createElement(CardState, { part: 'Persone', problem: 'La linea è ferma.', onRetry: () => undefined })), 'it'))).toBe('Impossibile caricare Persone La linea è ferma. Riprova')
  })
})

// ---- F-CO-K2 (the shared overview kit's rows): the strips ----------------------------------------------------------------------------
describe('F-CO-K2: the strips — Strips, Strip and StripSaid draw the markup the order\'s strips drew by hand', () => {
  /** A strip of the made-up record. */
  const row = (key: string): ReactNode => createElement(Strip, { key, tone: 'warning', mark: 'M' }, `Held ${key}`)

  it('the stylesheet: the box, the list, the row\'s tone rule (DS tone tokens) — and NO rule sets align-items on a strip', () => {
    const text = css()
    for (const rule of ['.fw-so-strips-box {', '.fw-so-strips {', '.fw-so-strip {', ".fw-so-strip[data-tone='danger'] {", ".fw-so-strip[data-tone='info'] {", '.fw-so-strip-mark {', '.fw-so-strip-said {', '.fw-so-strip-reading {']) expect(text.split(`\n${rule}`), rule).toHaveLength(2)
    expect(text).toMatch(/\n\.fw-so-strip \{[^}]*border-inline-start: var\(--nds-space-3\) solid var\(--nds-warning\);/)
    expect(text).toMatch(/\n\.fw-so-strip\[data-tone='danger'\] \{\s*border-inline-start-color: var\(--nds-danger\);/)
    // The row's baseline (.fw-so-ov-row) is the only alignment a strip has: whichever stylesheet a page loads first.
    const plain = text.replace(/\/\*[\s\S]*?\*\//g, '')
    let strips = 0
    for (const [, selectors, body] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      if (/\.fw-so-strip(?![\w-])/.test(selectors!)) {
        strips += 1
        expect(body, selectors).not.toMatch(/\balign-items\s*:/)
      }
    expect(strips).toBe(3)
    expect(text).toContain("/* No align-items here: the row's baseline wins (measured 2026-11-23). */")
  })

  it('Strip: the shared row with its tone, its mark, what it says — and its doors only when handed over; an anchor is its id', () => {
    expect(render(createElement(Strip, { tone: 'warning', mark: createElement('i') }, 'Held'))).toBe('<li class="fw-so-ov-row fw-so-strip" data-tone="warning"><span class="fw-so-strip-mark"><i></i></span><span class="fw-so-strip-said">Held</span></li>')
    expect(render(createElement(Strip, { tone: 'danger', mark: 'M', doors: createElement('a', { href: '#x' }, 'Open ›') }, 'Held'))).toBe('<li class="fw-so-ov-row fw-so-strip" data-tone="danger"><span class="fw-so-strip-mark">M</span><span class="fw-so-strip-said">Held</span><span class="fw-so-ov-doors"><a href="#x">Open ›</a></span></li>')
    // No door handed over (left out or null): no doors cell — a strip never draws an empty one.
    for (const doors of [undefined, null]) expect(render(createElement(Strip, { tone: 'info', mark: 'M', doors }, 'Held'))).toBe('<li class="fw-so-ov-row fw-so-strip" data-tone="info"><span class="fw-so-strip-mark">M</span><span class="fw-so-strip-said">Held</span></li>')
    // The DOM's attribute order: class, data-tone, id, tabindex (a link reaches the row: it takes the focus).
    expect(render(createElement(Strip, { tone: 'danger', mark: 'M', anchor: 'about-X-1' }, 'Held'))).toBe('<li class="fw-so-ov-row fw-so-strip" data-tone="danger" id="about-X-1" tabindex="-1"><span class="fw-so-strip-mark">M</span><span class="fw-so-strip-said">Held</span></li>')
  })

  it('StripSaid: the title with its age (its exact day in the title), then each quiet line in the kit\'s hint', () => {
    expect(render(createElement(StripSaid, { title: 'Quality hold', since: { iso: '2026-11-02T09:00:00Z', day: '02/11/2026', words: '3 d' }, lines: ['on 1 work order', 'Quality releases it'] }))).toBe('<span>Quality hold · <time datetime="2026-11-02T09:00:00Z" title="02/11/2026">3 d</time></span><span class="fw-ro-hint">on 1 work order</span><span class="fw-ro-hint">Quality releases it</span>')
    expect(render(createElement(StripSaid, { title: 'Paused' }))).toBe('<span>Paused</span>')
    expect(render(createElement(StripSaid, { title: 'Paused', since: null, lines: [] }))).toBe('<span>Paused</span>')
    // Inside a strip: what it says sits in the strip's words cell.
    expect(render(createElement(Strip, { tone: 'info', mark: 'M' }, createElement(StripSaid, { title: 'Paused', lines: ['Asked by the customer'] })))).toContain('<span class="fw-so-strip-said"><span>Paused</span><span class="fw-ro-hint">Asked by the customer</span></span>')
  })

  it('Strips: five rows → four drawn and "Show 1 more" (the kit\'s cap); four or fewer: no button; no row: the box and its list still', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map(row)
    const html = render(createElement(Strips, { label: 'What holds it', rows: five }))
    expect(html.startsWith('<div class="fw-so-strips-box"><ul class="fw-so-strips" aria-label="What holds it"><li class="fw-so-ov-row fw-so-strip"')).toBe(true)
    expect(html.match(/<li class="fw-so-ov-row fw-so-strip"/g)).toHaveLength(STRIPS_SHOWN)
    expect(textOf(html)).not.toContain('Held e')
    expect(html).toMatch(/<\/ul><button[^>]*aria-expanded="false"[^>]*>Show 1 more<\/button><\/div>$/)
    expect(textOf(render(createElement(Strips, { label: 'X', rows: five }), 'it'))).toContain('Mostra altri 1')
    expect(render(createElement(Strips, { label: 'X', rows: five.slice(0, 4) }))).not.toContain('<button')
    // A page may hand a cap of its own.
    expect(render(createElement(Strips, { label: 'X', rows: five, cap: 2 })).match(/<li /g)).toHaveLength(2)
    expect(textOf(render(createElement(Strips, { label: 'X', rows: five, cap: 2 })))).toContain('Show 3 more')
    expect(render(createElement(Strips, { label: 'X', rows: [] }))).toBe('<div class="fw-so-strips-box"><ul class="fw-so-strips" aria-label="X"></ul></div>')
  })

  it('Strips: while read, one quiet row after the rows; a failed read is the last row (danger, its mark, the page\'s words), Try again only with a retry', () => {
    expect(render(createElement(Strips, { label: 'X', rows: [row('a')], reading: true }))).toMatch(/<\/li><li class="fw-so-strip-reading"><span class="nds-skeleton"[^>]*><\/span><\/li><\/ul><\/div>$/)
    const failed = render(createElement(Strips, { label: 'X', rows: [row('a')], failed: { words: 'Holds could not be read', onRetry: () => undefined } }))
    expect(failed).toMatch(/<\/li><li class="fw-so-ov-row fw-so-strip" data-tone="danger"><span class="fw-so-strip-mark"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/span><span class="fw-so-strip-said">Holds could not be read<\/span><span class="fw-so-ov-doors"><button[^>]*>Try again<\/button><\/span><\/li><\/ul><\/div>$/)
    expect(textOf(render(createElement(Strips, { label: 'X', rows: [], failed: { words: 'Impossibile leggere i blocchi', onRetry: () => undefined } }), 'it'))).toBe('Impossibile leggere i blocchi Riprova')
    expect(render(createElement(Strips, { label: 'X', rows: [], failed: { words: 'Holds could not be read' } }))).not.toContain('<button')
    expect(render(createElement(Strips, { label: 'X', rows: [row('a')], failed: null }))).not.toContain('data-tone="danger"')
  })

  it('the strips\' words need no provider: "Show {count} more", "Show fewer" in both languages', () => {
    function Probe(): ReactNode {
      const words = useOverviewWords()
      return createElement('p', null, [words.showMore(2), words.showFewer].join(' | '))
    }
    expect(textOf(bare(createElement(Probe), 'en'))).toBe('Show 2 more | Show fewer')
    expect(textOf(bare(createElement(Probe), 'it'))).toBe('Mostra altri 2 | Mostra meno')
  })
})
// ---- end F-CO-K2 (strips)

// ---- F-CO-K2: the ONE list (People's and Linked records' lists, merged: settle S3) -------------------------------------------------
describe('F-CO-K2: the ONE list — RowList, Row and QuietLine; the rows\' words', () => {
  it('the stylesheet: one list rule set (the list, its rows on its columns, the label, the quiet line, the 480 / 360 rules), tokens only', () => {
    const text = css()
    const block = text.slice(text.indexOf("/* ── F-CO-K2 (the shared overview kit's rows): the ONE list"), text.indexOf('/* ── end F-CO-K2 (the ONE list) ── */'))
    expect(block.length).toBeGreaterThan(100)
    expect(block).toMatch(/\n\.fw-so-ov-list \{\s*display: grid;\s*grid-template-columns: max-content minmax\(0, 1fr\) auto;\s*gap: var\(--nds-space-10\) var\(--nds-space-12\);\s*margin: 0;\s*padding: 0;\s*list-style: none;\s*min-width: 0;\s*\}/)
    expect(block).toMatch(/\n\.fw-so-ov-list > \.fw-so-ov-row \{\s*grid-column: 1 \/ -1;\s*grid-template-columns: subgrid;\s*\}/)
    expect(block).toMatch(/\n\.fw-so-ov-label \{\s*color: var\(--nds-text-muted\);\s*\}/)
    expect(block).toMatch(/\n\.fw-so-ov-quiet \{\s*grid-column: 1 \/ -1;\s*margin: 0;\s*\}/)
    expect(block).toMatch(/@container fw-so-ov-card \(max-width: 479px\) \{\s*\.fw-so-ov-list \{\s*grid-template-columns: max-content minmax\(0, 1fr\);/)
    expect(block).toMatch(/@container fw-so-ov-card \(max-width: 359px\) \{\s*\.fw-so-ov-list \{\s*grid-template-columns: minmax\(0, 1fr\);/)
    // ONE list: its rules are said once in the file; no near-copy of another name.
    for (const rule of ['.fw-so-ov-list {', '.fw-so-ov-label {', '.fw-so-ov-quiet {']) expect(text.split(`\n${rule}`), rule).toHaveLength(2)
    expect(text).not.toMatch(/fw-so-(?:people|linked)-(?:list|label|line)\b/)
    // The quiet line is not Progress by line's row (.fw-so-ov-line, the order's own progress.css): a different name.
    expect(text).not.toMatch(/\.fw-so-ov-line\b/)
  })

  it('RowList: a list, named only when the page names it', () => {
    expect(render(createElement(RowList, null, 'rows'))).toBe('<ul class="fw-so-ov-list">rows</ul>')
    expect(render(createElement(RowList, { label: 'Linked records' }, 'rows'))).toBe('<ul class="fw-so-ov-list" aria-label="Linked records">rows</ul>')
  })

  it('Row: the label, the value the page hands, the doors — left out: no doors cell; null: an EMPTY one; given: the doors', () => {
    expect(render(createElement(Row, { label: 'Backup' }, createElement('span', null, 'Bea Esempio')))).toBe('<li class="fw-so-ov-row"><span class="fw-so-ov-label">Backup</span><span>Bea Esempio</span></li>')
    expect(render(createElement(Row, { label: 'Shipments', doors: null }, createElement('span', null, '2')))).toBe('<li class="fw-so-ov-row"><span class="fw-so-ov-label">Shipments</span><span>2</span><span class="fw-so-ov-doors"></span></li>')
    expect(render(createElement(Row, { label: 'Answers', doors: createElement('button', null, 'Change…') }, createElement('span', null, 'Bea Esempio')))).toBe('<li class="fw-so-ov-row"><span class="fw-so-ov-label">Answers</span><span>Bea Esempio</span><span class="fw-so-ov-doors"><button>Change…</button></span></li>')
    // A part that draws its own value and doors is handed as the value (no doors of the row then).
    expect(render(createElement(Row, { label: 'Supervisor' }, createElement('span', { className: 'x-value' }, 'V'), createElement('span', { className: 'x-doors' }, 'D')))).toBe('<li class="fw-so-ov-row"><span class="fw-so-ov-label">Supervisor</span><span class="x-value">V</span><span class="x-doors">D</span></li>')
  })

  it('QuietLine: the whole row wide, in the kit\'s hint', () => {
    expect(render(createElement(QuietLine, null, 'None yet: Shipments'))).toBe('<li class="fw-so-ov-quiet fw-ro-hint">None yet: Shipments</li>')
    expect(render(createElement(RowList, null, createElement(Row, { label: 'A' }, 'a'), createElement(QuietLine, null, 'q')))).toBe('<ul class="fw-so-ov-list"><li class="fw-so-ov-row"><span class="fw-so-ov-label">A</span>a</li><li class="fw-so-ov-quiet fw-ro-hint">q</li></ul>')
  })

  it('the rows\' words need no provider; a door\'s arrow never stands alone on a line (a no-break space before "›")', () => {
    function Probe(): ReactNode {
      const words = useOverviewWords()
      return createElement('p', null, [words.none('Shipments · Invoices'), words.door('Quote: Q-1'), words.labelled('Quote', 'Q-1'), words.unreadMany, words.unreadOne].join(' | '))
    }
    expect(textOf(bare(createElement(Probe), 'en'))).toBe('None yet: Shipments · Invoices | Quote: Q-1 › | Quote: Q-1 | Could not be read | Could not be read')
    expect(textOf(bare(createElement(Probe), 'it'))).toBe('Ancora nessuno: Shipments · Invoices | Quote: Q-1 › | Quote: Q-1 | Non è stato possibile leggerli | Non è stato possibile leggerlo')
    // door(): the catalogue word is "{value} ›"; what a part draws keeps "›" with its last word.
    expect(bare(createElement(Probe), 'en')).toContain('Quote: Q-1\u00a0›')
    expect(bare(createElement(Probe), 'en')).not.toContain('Quote: Q-1 ›')
    for (const locale of LOCALES) expect(CATALOGUE[locale][OVERVIEW_NS]!['row.door'], locale).toBe('{value} ›')
  })
})
// ---- end F-CO-K2 (the ONE list)

// ---- F-CO-K2: the facts ------------------------------------------------------------------------------------------------------------
describe('F-CO-K2: the facts — FactCols, Fact and Door (moved out of the order\'s Order facts as they were)', () => {
  it('the stylesheet: the facts\' block moved whole — one label column (subgrid), two column sets from 800 px, the wide note, tokens only', () => {
    const text = css()
    for (const rule of ['.fw-so-facts {', '.fw-so-ov-cols.fw-so-facts {', '.fw-so-facts > .fw-so-ov-row {', '.fw-so-facts > .fw-so-ov-row > .fw-so-ov-doors {', '.fw-so-fact-label {', '.fw-so-fact-value {', '.fw-so-fact-fixed {', '.fw-so-ov-row.fw-so-fact-note {', '.fw-so-fact-note > .fw-so-fact-value {', '.fw-so-fact-text {']) expect(text.split(`\n${rule}`), rule).toHaveLength(2)
    expect(text).toMatch(/@container fw-so-ov-card \(min-width: 800px\) \{\s*\.fw-so-ov-cols\.fw-so-facts \{\s*grid-template-columns: max-content minmax\(0, 1fr\) auto 0 max-content minmax\(0, 1fr\) auto;/)
    expect(text).toMatch(/@container fw-so-ov-card \(max-width: 359px\) \{\s*\.fw-so-ov-cols\.fw-so-facts \{\s*grid-template-columns: minmax\(0, 1fr\);/)
    // The wide note's rule comes after the facts' row rule (same weight: the note's columns win by that order, as before).
    expect(text.indexOf('\n.fw-so-ov-row.fw-so-fact-note {')).toBeGreaterThan(text.indexOf('\n.fw-so-facts > .fw-so-ov-row {'))
  })

  it('FactCols, Fact: the list, then label | value | door — the door handed the label\'s id; no door: no cell; wide: the note\'s row', () => {
    expect(render(createElement(FactCols, null, 'facts'))).toBe('<ul class="fw-so-ov-cols fw-so-facts">facts</ul>')
    const fact = render(createElement(Fact, { label: 'Season', value: 'SS27', door: (describedBy: string) => createElement('button', { 'aria-describedby': describedBy }, 'Set…') }))
    const id = /<span id="([^"]+)" class="fw-so-fact-label">Season<\/span>/.exec(fact)?.[1]
    expect(id).toBeTruthy()
    expect(fact).toBe(`<li class="fw-so-ov-row fw-so-fact"><span id="${id}" class="fw-so-fact-label">Season</span><span class="fw-so-fact-value">SS27</span><span class="fw-so-ov-doors"><button aria-describedby="${id}">Set…</button></span></li>`)
    expect(render(createElement(Fact, { label: 'Made', value: 'Today', door: null }))).toMatch(/^<li class="fw-so-ov-row fw-so-fact"><span id="[^"]+" class="fw-so-fact-label">Made<\/span><span class="fw-so-fact-value">Today<\/span><\/li>$/)
    expect(render(createElement(Fact, { label: 'Note', value: 'Words', door: null, wide: true }))).toMatch(/^<li class="fw-so-ov-row fw-so-fact fw-so-fact-note">/)
  })

  it('Door: the quiet DS button, held with words, described by its fact\'s label', () => {
    const free = render(createElement(Door, { label: 'Change…', held: null, describedBy: 'f-1', onClick: () => undefined }))
    expect(free).toMatch(/^<button[^>]*aria-describedby="f-1"[^>]*>Change…<\/button>$/)
    expect(free).not.toContain('aria-disabled')
    expect(render(createElement(Door, { label: 'Change…', held: 'The order is closed', describedBy: 'f-1', onClick: () => undefined }))).toMatch(/aria-disabled="true"[^>]*aria-description="The order is closed"|aria-description="The order is closed"[^>]*aria-disabled="true"/)
  })
})
// ---- end F-CO-K2 (facts)

// ---- F-CO-K2: the groups (Groups: settle S32) -----------------------------------------------------------------------------------------
describe('F-CO-K2: the groups — Groups, Group, GroupRow and RowAge draw the markup the order\'s Requests & changes drew by hand', () => {
  it('the stylesheet: the groups\' block moved whole (the groups, a group, its list on the row\'s columns, the age, the 480 / 360 rules)', () => {
    const text = css()
    for (const rule of ['.fw-so-rq-groups {', '.fw-so-rq-group {', '.fw-so-rq-list {', '.fw-so-rq-list > .fw-so-ov-row {', '.fw-so-rq-age {', '.fw-so-rq-more {', '.fw-so-rq-foot {']) expect(text.split(`\n${rule}`), rule).toHaveLength(2)
    expect(text).toMatch(/\n\.fw-so-rq-list \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) max-content auto;/)
    expect(text).toMatch(/@container fw-so-ov-card \(max-width: 359px\) \{\s*\.fw-so-rq-list > \.fw-so-ov-row \{\s*display: flex;/)
  })

  it('Groups: the groups\' column (a page never writes the class itself); Group: its section, its h3 in the kit\'s text class, its list, its door', () => {
    expect(render(createElement(Groups, null, 'groups'))).toBe('<div class="fw-so-rq-groups">groups</div>')
    expect(render(createElement(Group, { title: 'Waiting on us · 3' }, 'rows'))).toBe('<section class="fw-so-rq-group"><h3 class="fw-ro-h3">Waiting on us · 3</h3><ul class="fw-so-rq-list">rows</ul></section>')
    expect(render(createElement(Group, { title: 'Still to do · 5', more: createElement('a', { href: '#still' }, '2 more ›') }, 'rows'))).toBe('<section class="fw-so-rq-group"><h3 class="fw-ro-h3">Still to do · 5</h3><ul class="fw-so-rq-list">rows</ul><a href="#still">2 more ›</a></section>')
  })

  it('GroupRow: the words in ONE span, the age, the doors cell — ALWAYS drawn (empty for a reader with no door)', () => {
    const age = createElement('span', { className: 'fw-so-rq-age' }, '—')
    expect(render(createElement(GroupRow, { age, doors: createElement('button', null, 'Answer…') }, 'Size change', createElement('span', null, ' · Sales')))).toBe('<li class="fw-so-ov-row fw-so-rq-row"><span>Size change<span> · Sales</span></span><span class="fw-so-rq-age">—</span><span class="fw-so-ov-doors"><button>Answer…</button></span></li>')
    for (const doors of [undefined, null]) expect(render(createElement(GroupRow, { age, doors }, 'Size change'))).toBe('<li class="fw-so-ov-row fw-so-rq-row"><span>Size change</span><span class="fw-so-rq-age">—</span><span class="fw-so-ov-doors"></span></li>')
  })

  it('RowAge: a time with its exact day in the title (class, datetime, title); no start or no words: "—"', () => {
    expect(render(createElement(RowAge, { since: '2026-11-03T09:00:00Z', words: '15 d', title: 'since 03/11/2026, 10:00' }))).toBe('<time class="fw-so-rq-age" datetime="2026-11-03T09:00:00Z" title="since 03/11/2026, 10:00">15 d</time>')
    expect(render(createElement(RowAge, { since: null, words: '15 d' }))).toBe('<span class="fw-so-rq-age">—</span>')
    expect(render(createElement(RowAge, { since: '2026-11-03T09:00:00Z', words: null }))).toBe('<span class="fw-so-rq-age">—</span>')
  })
})
// ---- end F-CO-K2 (groups)

describe('the /design/record-overview lab', () => {
  it('has its own screen id (the design index finds every fixtures.ts by itself) and the frame\'s cases', () => {
    expect(designScreen.screen).toBe('record-overview')
    expect(readFileSync(fileURLToPath(new URL('../../../lib/design/design-screen.ts', import.meta.url)), 'utf8')).toContain("| 'record-overview'")
    expect(designScreen.cases.map((item) => item.id)).toEqual([
      ...['card', 'card-aside', 'card-aside-none', 'card-lead', 'card-busy', 'state-loading', 'state-failed', 'state-failed-no-retry', 'headline', 'headline-quiet', 'headline-reading', 'pair-two', 'pair-one', 'overview'],
      // F-CO-K2: the rows' cases
      ...['strips-tones', 'strips-more', 'strips-reading', 'strips-failed', 'strips-doors', 'strips-lines', 'rows', 'rows-doors', 'rows-quiet', 'facts', 'facts-note', 'groups', 'groups-more', 'overview-rows'],
    ])
    expect(LAB_WIDTHS).toEqual([343, 425, 829])
  })

  it('draws every case in both languages, in three rooms, with no key left on screen', () => {
    const drawn = everyCase(designScreen)
    expect(drawn).toHaveLength(designScreen.cases.length * LOCALES.length)
    for (const [locale, id, html] of drawn) {
      expect(leftKeys(html, ['lab', 'state', 'strips', 'row']), `${locale}/${id}`).toEqual([])
      // One room per width, each with ONE Overview of its own (the room is the Overview's width).
      expect([...html.matchAll(/<section class="fw-rol-room" style="width:(\d+)px"/g)].map((match) => Number(match[1])), `${locale}/${id}`).toEqual([...LAB_WIDTHS])
      expect(html.match(/<div class="fw-so-overview">/g), `${locale}/${id}`).toHaveLength(LAB_WIDTHS.length)
    }
  })

  it('the Italian frame speaks Italian; the cases show what their names say', () => {
    const html = (id: string, locale: Locale = 'en'): string => drawnOf(id, locale)
    for (const word of ['Scheda da 343 px', 'A che punto è', 'In lavorazione · Modellistica', 'Le sue fasi le segna la sala campioni.']) expect(textOf(html('card-lead', 'it')), word).toContain(word)
    expect(textOf(html('card-lead', 'it'))).not.toMatch(/Where it is now|In work|sample room/)
    expect(textOf(html('state-failed', 'it'))).toContain('Impossibile caricare Persone Il server della fabbrica non risponde: controlla la connessione e riprova. Riprova')
    // A bare title, a head row with nothing at its right, a head row with a link (the kit's link and hint on one element).
    expect(html('card')).toContain('<div class="nds-card pad"><h2 class="fw-ro-h2">Linked records</h2>')
    expect(html('card-aside-none')).toContain('<div class="nds-card pad"><div class="fw-ro-head"><h2 class="fw-ro-h2">People</h2></div>')
    expect(html('card-aside')).toContain('<div class="fw-ro-head"><h2 class="fw-ro-h2">Next dates</h2><a class="fw-ro-link fw-ro-hint" href="#record-overview-lab">All dates ›</a></div>')
    expect(html('card-busy')).toContain('<div class="nds-card pad" aria-busy="true"><h2 class="fw-ro-h2">Linked records</h2>')
    // The headline: alone, with its quiet line, while read (no quiet line then).
    expect(html('headline')).toContain('<div class="fw-so-where-said"><p class="fw-so-headline">In work · Pattern making</p></div>')
    expect(html('headline-quiet')).toContain('<p class="fw-so-headline">In work · Pattern making</p><p class="fw-ro-hint">Its stages are set by the sample room.</p>')
    expect(html('headline-reading')).not.toContain('fw-so-headline')
    expect(textOf(html('headline-reading'))).not.toContain('Its stages are set by the sample room.')
    // The states: Try again only where a retry is handed over.
    expect(textOf(html('state-loading'))).toContain('Loading People…')
    expect(html('state-failed').match(/>Try again<\/button>/g)).toHaveLength(LAB_WIDTHS.length)
    expect(html('state-failed-no-retry')).not.toContain('<button')
    // A pair of two holds two cards, a pair of one holds one; the frame together: the lead card, then two pairs.
    expect(html('pair-two').match(/<div class="fw-so-ov-pair"><div class="nds-card pad"><div class="fw-ro-head"><h2 class="fw-ro-h2">People<\/h2><\/div><p class="fw-ro-hint">[^<]+<\/p><\/div><div class="nds-card pad"><div class="fw-ro-head"><h2 class="fw-ro-h2">Next dates<\/h2>/g)).toHaveLength(LAB_WIDTHS.length)
    expect(html('pair-one').match(/<div class="fw-so-ov-pair"><div class="nds-card pad"><h2 class="fw-ro-h2">Linked records<\/h2><p class="fw-ro-hint">[^<]+<\/p><\/div><\/div>/g)).toHaveLength(LAB_WIDTHS.length)
    expect(html('overview').match(/<div class="fw-so-overview"><div class="nds-card pad fw-so-where">/g)).toHaveLength(LAB_WIDTHS.length)
    expect(html('overview').match(/<div class="fw-so-ov-pair">/g)).toHaveLength(2 * LAB_WIDTHS.length)
  })
  // F-CO-K2: the rows' cases show what their names say (in each of the three rooms).
  it('the rows\' cases: the strips, the ONE list, the facts, the groups — and Italian words in Italian', () => {
    const html = (id: string, locale: Locale = 'en'): string => drawnOf(id, locale)
    const rooms = LAB_WIDTHS.length
    const strips = (id: string): number => html(id).match(/<li class="fw-so-ov-row fw-so-strip"/g)?.length ?? 0
    expect(['warning', 'danger', 'info'].map((tone) => html('strips-tones').match(new RegExp(`data-tone="${tone}"`, 'g'))?.length)).toEqual([rooms, rooms, rooms])
    expect(strips('strips-more')).toBe(4 * rooms)
    expect(html('strips-more').match(/>Show 1 more<\/button>/g)).toHaveLength(rooms)
    expect(textOf(html('strips-more', 'it'))).toContain('Mostra altri 1')
    expect(html('strips-reading').match(/<li class="fw-so-strip-reading">/g)).toHaveLength(rooms)
    expect(html('strips-failed').match(/<span class="fw-so-strip-said">The holds could not be read<\/span><span class="fw-so-ov-doors"><button[^>]*>Try again<\/button>/g)).toHaveLength(rooms)
    expect(html('strips-doors').match(/<span class="fw-so-ov-doors"><button[^>]*>Lift the hold…<\/button><button[^>]*>Open ›<\/button><\/span>/g)).toHaveLength(rooms)
    expect(html('strips-lines').match(/<span class="fw-ro-hint">Quality releases it<\/span>/g)).toHaveLength(rooms)
    expect(html('strips-lines')).toContain('<time datetime="2026-11-21T09:00:00Z" title="21/11/2026">3 d</time>')
    // The ONE list: plain rows have no doors cell; Linked's shape keeps an empty one; quiet lines span the row.
    expect(html('rows')).not.toContain('fw-so-ov-doors')
    expect(html('rows').match(/<ul class="fw-so-ov-list">/g)).toHaveLength(rooms)
    expect(html('rows-doors').match(/<span class="fw-so-ov-doors"><button[^>]*>Change…<\/button><\/span>/g)).toHaveLength(rooms)
    expect(html('rows-quiet').match(/<ul class="fw-so-ov-list" aria-label="Linked records">/g)).toHaveLength(rooms)
    expect(html('rows-quiet').match(/<span class="fw-so-ov-doors"><\/span>/g)).toHaveLength(rooms)
    expect(html('rows-quiet').match(/<li class="fw-so-ov-quiet fw-ro-hint">None yet: Shipments · Invoices<\/li>/g)).toHaveLength(rooms)
    expect(html('rows-quiet')).toContain('Waiting on us · 2\u00a0›')
    // The facts: the list, a held door says why, "Fixed" in a door's place; the note takes the whole row.
    expect(html('facts').match(/<ul class="fw-so-ov-cols fw-so-facts">/g)).toHaveLength(rooms)
    expect(html('facts')).toMatch(/aria-description="The factory server is not answering: check the connection and try again\."/)
    expect(html('facts')).not.toContain('fw-so-fact-note')
    expect(html('facts-note').match(/<li class="fw-so-ov-row fw-so-fact fw-so-fact-note">/g)).toHaveLength(rooms)
    // The groups: three, each its h3; ages with their day or "—"; a cut group's door under its rows.
    expect(html('groups').match(/<section class="fw-so-rq-group"><h3 class="fw-ro-h3">/g)).toHaveLength(3 * rooms)
    expect(html('groups').match(/<div class="fw-so-rq-groups">/g)).toHaveLength(rooms)
    expect(html('groups')).toContain('<time class="fw-so-rq-age" datetime="2026-11-03T09:00:00Z" title="since 03/11/2026, 10:00">15 d</time>')
    expect(html('groups')).toContain('<span class="fw-so-rq-age">—</span>')
    expect(html('groups')).not.toContain('2 more ›')
    expect(html('groups-more').match(/<\/ul><a class="fw-ro-link fw-ro-hint" href="#record-overview-lab">2 more ›<\/a><\/section>/g)).toHaveLength(rooms)
    // The frame with its rows: the lead card with four strips, three pairs.
    expect(strips('overview-rows')).toBe(4 * rooms)
    expect(html('overview-rows').match(/<div class="fw-so-ov-pair">/g)).toHaveLength(3 * rooms)
    for (const id of ['strips-lines', 'rows-quiet', 'facts-note', 'groups-more']) expect(textOf(html(id, 'it')), id).not.toMatch(/Quality releases|None yet|Office note|Waiting on us|Shipments/)
    for (const word of ['Lo sblocca la qualità', 'Ancora nessuno: Spedizioni · Fatture', 'Nota dell\'ufficio', 'Tocca a noi · 2']) expect(['strips-lines', 'rows-quiet', 'facts-note', 'groups-more'].map((id) => textOf(html(id, 'it'))).join(' '), word).toContain(word)
  })
})

/** Every lab case in every language, drawn once (with every catalogue, as the design index draws it). */
let labDrawn: ReturnType<typeof everyCase> | null = null

/** One lab case drawn in a language. */
function drawnOf(id: string, locale: Locale): string {
  labDrawn ??= everyCase(designScreen)
  const found = labDrawn.find(([language, caseId]) => language === locale && caseId === id)
  if (!found) throw new Error(`no lab case ${id}`)
  return found[2]
}
