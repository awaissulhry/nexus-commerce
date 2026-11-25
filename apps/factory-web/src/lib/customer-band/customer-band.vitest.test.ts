import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { metricKind } from '@nexus/ui/components'
import { LOCALES } from '../i18n/locales'
import { createTranslator, messagesFor } from '../i18n/messages'
import { I18nProvider } from '../i18n/provider'
import { BAND_FOLD_BELOW, foldOf, metricsOf, oursOf, OURS_ACCENT, type BandTile } from './customer-band'
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
    expect(foldOf([tile('A', 2), tile('B', 1)], everything)).toEqual({ id: null, label: everything.label, value: '14', ours: null })
    expect(foldOf([tile('A', 2), tile('B', 1, { pressed: true })], everything)).toEqual({ id: 'B', label: 'Group B', value: '1', ours: null })
    expect(BAND_FOLD_BELOW).toBe(720)
  })

  it('fx1 (walk B-05): "waits on us" in words where no tip is read — the group waits on us AND holds something', () => {
    const words = 'waits on us'
    expect(oursOf(tile('A', 1, { ours: true, oursWords: words }))).toBe(words)
    expect([oursOf(tile('A', 0, { ours: true, oursWords: words })), oursOf(tile('A', null, { ours: true, oursWords: words })), oursOf(tile('A', 3, { oursWords: words }))]).toEqual([null, null, null])
    expect(foldOf([tile('A', 2, { pressed: true, ours: true, oursWords: words })], { label: 'x', value: '2' }).ours).toBe(words)
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
    info: 'About these numbers',
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

  it('the phone (lead, overflow): the chips flow, never a grid; a long chip shows its short words there, its name keeps the long ones', () => {
    const items = [{ id: 'customer', label: 'Waiting for Seed Customer Three GmbH', short: 'Waiting for the customer', count: '2', title: 'Waiting on Seed Customer Three GmbH', dialog: true, onPress: () => undefined }]
    const page = html({ chips: { label: 'What waits', items } })
    expect(page).toContain('<span class="fw-cb-chip-long">Waiting for Seed Customer Three GmbH</span><span class="fw-cb-chip-short">Waiting for the customer</span>')
    expect(page).toContain('title="Waiting on Seed Customer Three GmbH" aria-label="Waiting for Seed Customer Three GmbH 2"')
    const css = readFileSync(new URL('./customer-band.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-cb-chip-short \{\s*display: none;/)
    const phone = css.slice(css.indexOf('@container fw-cb (max-width: 719px)'))
    expect(phone).toMatch(/\.fw-cb-chip-long \{\s*display: none;\s*\}\s*\.fw-cb-chip-short \{\s*display: inline;/)
    expect(phone.slice(0, phone.indexOf('/* ---- the groups\' window'))).not.toContain('grid')
    expect(css).toMatch(/\.fw-cb-chips \{\s*display: flex;\s*flex-wrap: wrap;/)
  })

  it('fx1 (walk B-01, B-06): ONE ⓘ — the DS icon button that opens the window — glued to the last item of its row, never alone', () => {
    const button = 'class="nds-btn quiet sm icon" aria-label="About these numbers" title="About these numbers" aria-haspopup="dialog"'
    // With a chips row: in one box with the last chip.
    const chips = html()
    expect(chips.match(/aria-label="About these numbers"/g)?.length).toBe(1)
    expect(chips).toMatch(/<span class="fw-cb-tail"><button[^>]*class="nds-fchip"[^>]*>(?:(?!<\/button>).)*Replies(?:(?!<\/button>).)*<\/button>|<span class="fw-cb-tail"><span class="fw-cb-fact"[^>]*>Replies/)
    expect(chips).toContain(button)
    // Without one (the Quotes tab): at the end of the notes line, in one box with the last closed group.
    const notes = html({ chips: undefined })
    expect(notes).not.toContain('What waits')
    expect(notes).toMatch(/<span class="fw-cb-closed">.*<span class="fw-cb-tail"><button[^>]*class="nds-fchip"[^>]*>.*?Group X.*?<\/button><span class="fw-cb-info">/)
    // No groups to show: no ⓘ (its window would be empty).
    expect(html({ chips: undefined, groups: [], closed: { groups: [] }, state: 'reading' })).not.toContain('About these numbers')
    const css = readFileSync(new URL('./customer-band.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-cb-tail \{\s*display: inline-flex;\s*flex: 1 0 auto;/)
    expect(css).toMatch(/\.fw-cb-roomy \{\s*display: none;/)
    expect(css).toMatch(/@container fw-cb \(min-width: 1040px\) \{\s*\.fw-cb-chips-w,\s*\.fw-cb-roomy \{\s*display: inline;/)
  })

  it('fx1 (walk B-05): on a phone "waits on us" is said — the fold showing such a group, and each such row of the window', () => {
    const ours = { ours: true, oursWords: 'waits on us' }
    // The fold (drawn on the server; the band's room shows it on a phone): the pressed group waits on us and holds 2.
    const shown = html({ groups: [tile('A', 2, { ...ours, pressed: true }), tile('B', 0, ours)] })
    expect(shown.match(/class="nds-pill warning has-dot"/g)?.length).toBe(1)
    expect(shown).toContain('waits on us')
    // A group that waits on us but holds nothing, or none shown: no mark.
    expect(html({ groups: [tile('A', 0, { ...ours, pressed: true })] })).not.toContain('nds-pill warning has-dot')
    expect(html({ groups: [tile('A', 2, ours)] })).not.toContain('nds-pill warning has-dot')
    // The window (drawn once open, in the browser): its rows use the same rule and the same DS pill.
    const part = readFileSync(new URL('./CustomerBand.tsx', import.meta.url), 'utf8')
    const rows = part.slice(part.indexOf('const ours = oursOf(group)'))
    expect(rows).toMatch(/\{ours && \(\s*<Pill tone="warning" dot>\s*\{ours\}/)
    expect(part).toMatch(/\{fold\.ours && \(\s*<Pill tone="warning" dot>\s*\{fold\.ours\}/)
  })

  it('fx2 (re-look B-08, B-09): the groups\' rule only where the chips hold one line; the open door is no live region', () => {
    const css = readFileSync(new URL('./customer-band.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-cb-rule \{\s*display: none;/)
    expect(css).toMatch(/@container fw-cb \(min-width: 1140px\) \{\s*\.fw-cb-rule \{\s*display: block;/)
    expect(css).toMatch(/\.fw-cb\.has-chips \.fw-cb-rule \{\s*display: none;/) // the 1500 px layout draws none
    // The open door's buttons sit in no live region (aria-pressed and the chip say the state); a failed read is still announced.
    const page = html({ status: createElement('button', { type: 'button' }, 'Lost ✕') })
    expect(page).toContain('<div class="fw-cb-status"><button type="button">Lost ✕</button></div>')
    expect(page).not.toContain('role="status"')
    expect(html({ state: 'failed' })).toContain('<p class="fw-cb-failed" role="status">')
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
    const work = src('../../areas/sales/customers/record/view/WorkBand.tsx')
    expect(work).toContain('<CustomerBand')
    expect(work).toContain('value: <span className="fw-cwb-num">{number(group.count)}</span>,')
    expect(work).toContain("groupsLabel: t('customers.work.band.pipeline'),")
    expect(work).toContain("const cancelled = picture.groups.filter((group) => group.phase === 'CANCELLED').map(tileOf)")
    expect(work).toContain('closed: { groups: cancelled },')
    // fx1 (walk B-07): "Work orders of <customer> ›" on the notes line only from 1040 px (the window says it below), Cancelled stays.
    expect(work).toContain('{workOrders && <span className="fw-cb-roomy">{workOrders}</span>}')
    expect(work).toContain("info: t('customers.work.band.info'),")
    // The two doors that navigate: the host's (WorkTab: router.push), the view stays pure.
    expect(work).toContain('onPress: () => actions?.onGo?.(href, true)')
    expect(src('../../areas/sales/customers/record/view/WorkTab.tsx')).toContain('onGo: (href: string, keepScroll: boolean) => router.push(href, keepScroll ? { scroll: false } : undefined),')
  })
  it('Quotes: the doors are filter tiles (the host\'s ONE replace), `fw-bo-count`, the group named band.pipeline, "Closed:" apart', () => {
    const quotes = src('../../areas/sales/customers/record/quotes-tab/view/BeforeOrderBand.tsx')
    expect(quotes).toContain('<CustomerBand')
    expect(quotes).toContain('value: <span className="fw-bo-count">{door.count}</span>,')
    expect(quotes).toContain("groupsLabel: b('band.pipeline'),")
    expect(quotes).toContain("closed: { word: b('band.closed'), groups: band ? band.closed.map(tileOf) : [] },")
    expect(quotes).toContain('actions={{ onGroup: (id) => actions?.onDoor?.(id as Door) }}')
    expect(quotes).not.toContain('BAND_EDGES')
    // fx1 (walk B-02, B-03, B-05, B-06): the open door = the Orders sheet's own chip + why; the ONE ⓘ (no InfoTip); "waits on us" words.
    expect(quotes).toContain("<SheetChips chips={[{ id: model.door, label: label(model.door), onClear: () => actions?.onCloseDoor?.(), note: b(`door.why.${model.door}`) }]} t={s} onClearAll={() => actions?.onCloseDoor?.()} />")
    expect(quotes).toContain("info: p('customers.work.band.info'),")
    expect(quotes).not.toContain('InfoTip')
    expect(quotes).toContain("oursWords: b('band.waitsOn', { who: b('band.who.us') }),")
    const hook = src('../../areas/sales/customers/record/quotes-tab/use-quotes-tab.ts')
    expect(hook).toContain('const onDoor = useCallback((each: Door) => go(hrefs[each]), [go, hrefs])')
    expect(hook.match(/router\.replace\(/g)?.length).toBe(1)
    expect(src('../../areas/sales/customers/record/QuotesIncomingTab.tsx')).toContain('onCloseDoor, onDoor /* F-CQ-B */, onRetry }}')
  })
  it('the phone\'s button says everything before an order; "Waiting for <customer>" has its short words — both languages', () => {
    for (const locale of LOCALES) {
      const b = createTranslator(locale, messagesFor(locale, ['before-order'])['before-order']!)
      expect(b('band.everything'), locale).not.toBe('band.everything')
    }
    const parties = (locale: (typeof LOCALES)[number]) => createTranslator(locale, messagesFor(locale, ['parties']).parties!)
    expect([parties('en')('customers.work.tile.customerShort'), parties('it')('customers.work.tile.customerShort')]).toEqual(['Waiting for the customer', 'In attesa del cliente'])
    expect(src('../../areas/sales/customers/record/view/WorkBand.tsx')).toContain("return chip.tile === 'customer' ? { ...item, short: t('customers.work.tile.customerShort') } : item")
  })
})
