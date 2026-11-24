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
import { LAB_WIDTHS } from './view/OverviewLab'

/**
 * F-CO-K1 (customer overview lane: the shared overview kit) — the kit's own rules, pinned:
 *   - the wall: it imports no page (no order, no party, no purchasing), fetches nothing and speaks only its own catalogue;
 *   - its stylesheet's public contract (the two rooms' names, the shared row, the text rules' order), tokens only, and ONE
 *     stylesheet for the parts;
 *   - each frame part's markup — the markup the order's Overview drew by hand before it moved here;
 *   - its lab: every case draws in both languages with no key left.
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
    expect(importsOf(source('Overview.tsx')).sort()).toEqual(['../../../lib/i18n/messages', '../../../lib/i18n/provider', '../../../record-panels/i18n', './model', './record-overview.css', '@nexus/ui/components', '@nexus/ui/primitives', 'react'].sort())
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

describe('the /design/record-overview lab', () => {
  it('has its own screen id (the design index finds every fixtures.ts by itself) and the frame\'s cases', () => {
    expect(designScreen.screen).toBe('record-overview')
    expect(readFileSync(fileURLToPath(new URL('../../../lib/design/design-screen.ts', import.meta.url)), 'utf8')).toContain("| 'record-overview'")
    expect(designScreen.cases.map((item) => item.id)).toEqual(['card', 'card-aside', 'card-aside-none', 'card-lead', 'card-busy', 'state-loading', 'state-failed', 'state-failed-no-retry', 'headline', 'headline-quiet', 'headline-reading', 'pair-two', 'pair-one', 'overview'])
    expect(LAB_WIDTHS).toEqual([343, 425, 829])
  })

  it('draws every case in both languages, in three rooms, with no key left on screen', () => {
    const drawn = everyCase(designScreen)
    expect(drawn).toHaveLength(designScreen.cases.length * LOCALES.length)
    for (const [locale, id, html] of drawn) {
      expect(leftKeys(html, ['lab', 'state']), `${locale}/${id}`).toEqual([])
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
