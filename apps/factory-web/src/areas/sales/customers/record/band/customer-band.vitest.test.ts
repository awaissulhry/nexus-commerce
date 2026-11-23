import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { metricKind } from '@nexus/ui/components'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { BAND_FOLD_BELOW, foldOf, metricsOf, OURS_ACCENT, type BandTile } from './customer-band'
import { CustomerBand, type CustomerBandModel } from './CustomerBand'

/**
 * F-CQ-B (band consistency, Owner 2026-11-23; band/plan.md B1–B11) — the customer page's ONE band: the Work tab and Quotes & incoming
 * draw their groups with the design system's own parts, as Sales › Orders does (compact filter tiles, quiet FilterChips); the same
 * doors, counts and words. Made-up data only.
 */

const tile = (id: string, count: number | null, over: Partial<BandTile> = {}): BandTile => ({ id, label: `Group ${id}`, count, value: count === null ? '—' : String(count), door: true, pressed: false, ...over })

describe('F-CQ-B: the groups as the design system\'s tiles', () => {
  it('a door is a filter tile (a button that says it is pressed); a count without a door is a plain tile, no focus stop', () => {
    const picks: string[] = []
    const metrics = metricsOf([tile('A', 2, { pressed: true }), tile('B', 0), tile('C', 3, { door: false })], (id) => picks.push(id))
    expect(metrics.map((metric) => metricKind(metric))).toEqual(['button', 'button', 'static'])
    expect(metrics.map((metric) => ('active' in metric ? metric.active : undefined))).toEqual([true, false, undefined])
    metrics[1]!.onClick?.()
    expect(picks).toEqual(['B'])
    // 0 shows 0 (B5): the number is the host's, never hidden.
    expect(metrics[1]!.value).toBe('0')
    // A door is a button even without a handler (the gallery's made-up cases press nothing).
    expect(metricKind(metricsOf([tile('A', 1)])[0]!)).toBe('button')
  })

  it('"waits on us": the warning dot only when > 0, the words in the tip — never colour alone (B5)', () => {
    const [some, none, unread] = metricsOf([tile('A', 3, { ours: true, title: 'Show the 3 in “To answer” · waits on us' }), tile('B', 0, { ours: true }), tile('C', null, { ours: true })])
    expect(some!.accent).toBe(OURS_ACCENT)
    expect(OURS_ACCENT).toBe('var(--nds-warning)')
    expect(some!.title).toBe('Show the 3 in “To answer” · waits on us')
    expect([none!.accent, unread!.accent]).toEqual([undefined, undefined])
    expect(metricsOf([tile('D', 4)])[0]!.accent).toBeUndefined()
  })

  it('the phone\'s ONE button: the group shown (a closed one too), else everything with its number', () => {
    const everything = { label: 'All orders of Seed Customer One', value: '14' }
    expect(foldOf([tile('A', 2), tile('B', 1)], everything)).toEqual({ id: null, label: everything.label, value: '14' })
    expect(foldOf([tile('A', 2), tile('B', 1, { pressed: true })], everything)).toEqual({ id: 'B', label: 'Group B', value: '1' })
    expect(BAND_FOLD_BELOW).toBe(720)
  })
})

describe('F-CQ-B: the band draws the design system\'s parts', () => {
  const model = (over: Partial<CustomerBandModel> = {}): CustomerBandModel => ({
    label: 'All orders of Seed Customer One',
    groupsLabel: 'Orders by where they are',
    groups: [tile('A', 2, { pressed: true, title: 'Showing: Group A' }), tile('B', 0), tile('C', 1, { door: false })],
    state: 'ready',
    failed: 'Couldn’t be read · Try again',
    closed: { word: 'Closed:', groups: [tile('X', 4)] },
    notes: 'All orders: 7',
    chips: { label: 'What waits', items: [{ id: 'late', label: 'Late', count: '1', pressed: true, onPress: () => undefined }, { id: 'tasks', label: 'Open tasks', count: '0', dialog: true, rule: true, onPress: () => undefined }, { id: 'replies', label: 'Replies', count: '2' }] },
    info: { window: 'About these numbers' },
    everything: { label: 'All orders of Seed Customer One', value: '7' },
    window: { title: 'All orders of Seed Customer One' },
    ...over,
  })
  const html = (over: Partial<CustomerBandModel> = {}) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(CustomerBand, { model: model(over) })))

  it('ready: compact tiles in a named group, the pressed one marked, the closed ones as quiet chips, the facts as chips', () => {
    const page = html()
    expect(page).toContain('aria-label="All orders of Seed Customer One"')
    expect(page).toContain('role="group" aria-label="Orders by where they are"')
    expect(page).toContain('class="nds-metrics sm"')
    expect(page).toContain('class="nds-metric btn active" aria-pressed="true" title="Showing: Group A"')
    expect(page.match(/class="nds-metric btn/g)?.length).toBe(2) // the plain group is a card, not a button
    expect(page).toContain('Closed:')
    expect(page.match(/class="nds-fchip/g)?.length).toBe(3) // the closed group, Late, Open tasks (Replies has no door: a quiet fact)
    expect(page).toContain('aria-haspopup="dialog"')
    expect(page).toContain('role="group" aria-label="What waits"')
    expect(page).toContain('fw-cb-fact')
    // No chevrons and no marks in the tiles (B4); the phone's button is drawn and folded away by the band's own room.
    expect(page).not.toContain('nds-metric-go')
    expect(page).toContain('fw-cb-foldbox')
  })

  it('while read: a Skeleton of the strip; a failed read: the host\'s words, once, in the strip\'s place', () => {
    const reading = html({ state: 'reading' })
    expect(reading).toContain('nds-skeleton')
    expect(reading).not.toContain('nds-metrics')
    const failed = html({ state: 'failed' })
    expect(failed.match(/Couldn’t be read · Try again/g)?.length).toBe(1)
    expect(failed).toContain('role="status"')
    expect(failed).not.toContain('nds-metrics')
  })

  it('a band without chips puts its ⓘ at the end of the notes line', () => {
    const page = html({ chips: undefined, info: { tip: createElement('span', { className: 'seed-tip' }, 'i') } })
    expect(page).toContain('seed-tip')
    expect(page).not.toContain('What waits')
  })

  it('sized by its OWN room (a container), never the window; tokens only; no outer card; it fetches nothing', () => {
    const css = readFileSync(new URL('./customer-band.css', import.meta.url), 'utf8')
    expect(css).toContain('container: fw-cb / inline-size;')
    expect(css).toContain('@container fw-cb (max-width: 719px)')
    expect(css).toContain('@container fw-cb (min-width: 1500px)')
    expect(css).not.toContain('@media')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(css).not.toMatch(/\.nds-/) // the design system's parts are never restyled here
    expect(css).not.toMatch(/\.fw-cb \{[^}]*border:/) // B3: no outer card
    const part = readFileSync(new URL('./CustomerBand.tsx', import.meta.url), 'utf8')
    expect(part).toContain('<MetricStrip size="sm" metrics={metricsOf(model.groups, pick)} />')
    expect(part).not.toMatch(/lib\/api\/|lib\/session\/|fetch\(|matchMedia|innerWidth/)
  })
})

describe('F-CQ-B: both tabs draw the ONE band, their pins kept (B11)', () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('Work: the seven groups (Cancelled apart), the number class `fw-cwb-num`, the group named customers.work.band.pipeline', () => {
    const work = src('../view/WorkBand.tsx')
    expect(work).toContain('<CustomerBand')
    expect(work).toContain('value: <span className="fw-cwb-num">{number(group.count)}</span>,')
    expect(work).toContain("groupsLabel: t('customers.work.band.pipeline'),")
    expect(work).toContain("const cancelled = picture.groups.filter((group) => group.phase === 'CANCELLED').map(tileOf)")
    expect(work).toContain('closed: { groups: cancelled },')
    // The two doors that navigate: the host's (WorkTab: router.push), the view stays pure.
    expect(work).toContain('onPress: () => actions?.onGo?.(href, true)')
    expect(src('../view/WorkTab.tsx')).toContain('onGo: (href: string, keepScroll: boolean) => router.push(href, keepScroll ? { scroll: false } : undefined),')
  })
  it('Quotes: the doors are filter tiles (the host\'s ONE replace), `fw-bo-count`, the group named band.pipeline, "Closed:" apart', () => {
    const quotes = src('../quotes-tab/view/BeforeOrderBand.tsx')
    expect(quotes).toContain('<CustomerBand')
    expect(quotes).toContain('value: <span className="fw-bo-count">{door.count}</span>,')
    expect(quotes).toContain("groupsLabel: b('band.pipeline'),")
    expect(quotes).toContain("closed: { word: b('band.closed'), groups: band ? band.closed.map(tileOf) : [] },")
    expect(quotes).toContain('actions={{ onGroup: (id) => actions?.onDoor?.(id as Door) }}')
    expect(quotes).not.toContain('BAND_EDGES')
    const hook = src('../quotes-tab/use-quotes-tab.ts')
    expect(hook).toContain('const onDoor = useCallback((each: Door) => go(hrefs[each]), [go, hrefs])')
    expect(hook.match(/router\.replace\(/g)?.length).toBe(1)
    expect(src('../QuotesIncomingTab.tsx')).toContain('onCloseDoor, onDoor /* F-CQ-B */, onRetry }}')
  })
  it('the phone\'s button says everything before an order in both languages', () => {
    for (const locale of LOCALES) {
      const b = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      expect(b('band.everything'), locale).not.toBe('band.everything')
    }
  })
})
