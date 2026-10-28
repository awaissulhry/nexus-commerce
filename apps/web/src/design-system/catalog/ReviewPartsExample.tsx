'use client'

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { BarChart3, Clock, Inbox, LayoutDashboard, ListChecks, Settings } from 'lucide-react'

import { Button, Checkbox, Pill, Textarea } from '../primitives'
import { Banner, Heatmap, MetricStrip, PerformanceGraph, RatingBars, StarRating, heatKey, type ChartSeries, type Metric, type RatingStars } from '../components'
import { chart } from '../tokens'
import {
  Builder, EditModeBar, Lightbox, ReplyComposer, WorkspaceSubheader, photoAlt,
  type LightboxItem, type ReplyTemplate, type WorkspaceNavGroup, type WorkspaceSubheaderProps,
} from '../patterns'

/*
 * 2026-10-26 — Reviews parts (lane L1). Made-up buyers and products; no channel is called.
 * Verify:
 *  - Stars: 4.3 shows four, 4.7 four and a half (a clipped star); the name keeps the number ("4.3 out of 5 stars").
 *    Input: one Tab stop, ←/→ Home/End pick as they move; the empty outline is still visible (3:1).
 *  - RatingBars: a bar is a toggle (press the pressed one to clear); the 3-star bar with no ratings is held — focus it:
 *    the reason shows and is read, Enter does nothing. The shares add up to 100. No ratings: "No ratings yet".
 *  - MetricStrip: "New reviews" is a link (opens a new tab with ⌘-click), "Needs a reply" filters; at 390 px two per row.
 *  - Banner: two actions wrap inside their slot; at 390 px they take their own line and the dismiss stays up top.
 *  - Textarea: the counter counts, never blocks; over 500 it turns red and says how much is too long.
 *  - Heatmap: the outlined cells are the hours we send; hover a cell for its words.
 *  - Heatmap with theme names (Insights): the 120 px label column fits "Fit & sizing"; the cells are buttons — one Tab
 *    stop, the arrows move between measured days (striped days are skipped), Enter says which cell was pressed.
 *  - WorkspaceSubheader pinned: from 1024 px a column with Collapse (48 px strip); below, the "Reviews" button opens the
 *    drawer. The top group has no label on screen.
 *  - Builder page mode: the strip sticks while the page scrolls and marks the section on screen; a click scrolls there.
 *    The aside sits on the right from 1200 px. ⌘S / Ctrl+S saves (not while held); leaving asks first while dirty.
 *  - ReplyComposer: type past 500 — the send is held "Cut N characters…"; Templates fills the text; Draft with AI shows
 *    the English line. Lightbox: ←/→ move, held at the ends with words; photo 3 fails and says so; Esc gives focus back.
 *  - PerformanceGraph bars: bars sit under the line; the legend's bar swatches are squares; hover names each stacked
 *    part (Positive, Neutral, Negative) in its colour. At 390 px the legend wraps.
 *  - Light and dark, 390 px and 1280 px.
 */

const HOURS = Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? String(h).padStart(2, '0') : ''))
const HOUR_TITLES = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const SEND_AT = [9, 10, 9, 18, 9, 11, 19]
const HEAT: Array<Array<number | null>> = DAYS.map((_, d) => HOURS.map((__, h) => (h < 6 ? null : ((h * 7 + d * 5) % 23) / 100)))
const MARKED = new Set(SEND_AT.map((h, d) => heatKey(d, h)))
const THEMES = ['Fit & sizing', 'Durability', 'Comfort', 'Shipping']
const THEME_DAYS = Array.from({ length: 14 }, (_, i) => `${i + 13} Oct`)
const THEME_HEAT: Array<Array<number | null>> = THEMES.map((_, t) => THEME_DAYS.map((__, d) => ((d + t) % 5 === 0 ? null : ((d * 3 + t * 7) % 9))))

const TEMPLATES: ReplyTemplate[] = [
  { id: 'size', label: 'Size advice — runs small', description: 'Fit & sizing', body: 'Thank you for the feedback! This jacket runs small: we suggest one size up. Write to us if you want to exchange it.' },
  { id: 'thanks', label: 'Thanks for the review', description: 'Positive', body: 'Thank you very much for the review! We are glad you like the jacket. Ride safe!' },
]

// A synthetic buyer photo: no text inside the picture. An SVG shown as an image cannot use the page's fonts, so lettering
// in it was drawn in the system font (Arial on Windows, Helvetica on a Mac) — the DS-fonts rule (2026-10-28). The number of
// dots tells the pictures apart; the alt names them.
function photo(dots: number, tint: string): string {
  const marks = Array.from({ length: dots }, (_, i) => `<circle cx='${320 + (i - (dots - 1) / 2) * 56}' cy='240' r='16' fill='dimgray'/>`).join('')
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='480'><rect width='640' height='480' fill='${tint}'/>${marks}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
const PHOTOS: LightboxItem[] = [
  { url: photo(1, 'gainsboro'), alt: photoAlt(0, 4, 'Jonas K.') },
  { url: photo(2, 'lightgray'), alt: photoAlt(1, 4, 'Jonas K.') },
  { url: 'https://nexus.invalid/review-photo-3.jpg', alt: photoAlt(2, 4, 'Jonas K.') },
  { url: photo(4, 'silver'), alt: photoAlt(3, 4, 'Jonas K.') },
]

const NAV_ICON = { size: 16, 'aria-hidden': true } as const

// PerformanceGraph bars (2026-10-26, lane L12): imported reviews per week as bars under the average line; eBay feedback
// by type as stacked bars with the share of positive on the right axis.
const WEEKS = [['1 Sep', 9, 4.4], ['8 Sep', 14, 4.3], ['15 Sep', 6, 4.5], ['22 Sep', 0, null], ['29 Sep', 11, 4.1], ['6 Oct', 17, 4.2]] as const
const WEEK_ROWS = WEEKS.map(([when, reviews, avg]) => ({ when, reviews, avg: avg ?? Number.NaN }))
const WEEK_BARS: ChartSeries = { key: 'reviews', label: 'Imported reviews per week', color: chart.reference, axis: 'left', shape: 'bar', axisLabel: 'Reviews per week' }
const WEEK_LINE: ChartSeries = { key: 'avg', label: 'Average rating', color: chart.actual, axis: 'right', axisLabel: 'Average rating', domain: [3, 5], ticks: [3, 3.5, 4, 4.5, 5], format: (v) => v.toFixed(1) }
const TYPE_ROWS = [
  { when: 'Last 30 days', positive: 18, neutral: 1, negative: 0, pct: 100 },
  { when: 'Last 6 months', positive: 90, neutral: 4, negative: 2, pct: 97.8 },
  { when: 'Last 12 months', positive: 171, neutral: 7, negative: 3, pct: 98.3 },
]
const TYPE_STACK: ChartSeries = {
  key: 'feedback', label: 'Feedback', color: chart.reference, axis: 'left', axisLabel: 'Feedback',
  stack: [
    { key: 'positive', label: 'Positive', color: chart.positive },
    { key: 'neutral', label: 'Neutral', color: chart.neutral },
    { key: 'negative', label: 'Negative', color: chart.negative },
  ],
}
const TYPE_LINE: ChartSeries = { key: 'pct', label: '% positive', color: chart.actual, axis: 'right', axisLabel: '% positive', domain: [90, 100], format: (v) => `${v.toFixed(1)}%` }

export function ReviewPartsExample() {
  const [stars, setStars] = useState<number | null>(4)
  const [bar, setBar] = useState<RatingStars | null>(null)
  const [heatPick, setHeatPick] = useState<string | null>(null)
  const [tile, setTile] = useState<'reply' | 'alerts' | null>(null)
  const [note, setNote] = useState('')
  const [page, setPage] = useState('overview')
  const [navOpen, setNavOpen] = useState(false)
  const [dirty, setDirty] = useState(2)
  const [problem, setProblem] = useState(false)
  const [saved, setSaved] = useState(0)
  const [reply, setReply] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [english, setEnglish] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [chrome, setChrome] = useState<WorkspaceSubheaderProps['chrome']>()
  useEffect(() => setChrome({ header: document.querySelector('.nds-topbar'), primaryNavigation: document.querySelector('.h10-rail') }), [])

  const metrics = useMemo<Metric[]>(() => [
    { label: 'Average rating', value: '4.4', delta: { value: 'same as the month before', tone: 'neutral' }, hint: <StarRating value={4.4} size="sm" />, href: '/design-system#review-parts-example' },
    { label: 'New reviews', value: '38', delta: { value: '+6 vs last 30 days', positive: true }, hint: 'opens the Inbox', href: '/design-system#review-parts-example' },
    { label: 'Needs a reply', value: '12', hint: 'oldest waits 3 days', accent: 'var(--nds-danger)', active: tile === 'reply', onClick: () => setTile(t => (t === 'reply' ? null : 'reply')) },
    { label: 'Open alerts', value: '3', hint: '1 new today', accent: 'var(--nds-warning)', active: tile === 'alerts', onClick: () => setTile(t => (t === 'alerts' ? null : 'alerts')) },
  ], [tile])

  const item = (id: string, label: string, icon: ReactNode, badge?: number) => ({ id, label, href: '#review-parts-example', icon, active: page === id, badge })
  const groups: WorkspaceNavGroup[] = [
    { id: 'reviews', label: 'Reviews pages', hideLabel: true, items: [item('overview', 'Overview', <LayoutDashboard {...NAV_ICON} />), item('inbox', 'Inbox', <Inbox {...NAV_ICON} />, 12)] },
    { id: 'requests', label: 'Requests', collapsible: true, items: [item('queue', 'Queue', <ListChecks {...NAV_ICON} />), item('timing', 'Timing', <Clock {...NAV_ICON} />)] },
    { id: 'insights', label: 'Insights', collapsible: true, items: [item('themes', 'Themes', <BarChart3 {...NAV_ICON} />)] },
    { id: 'settings', label: 'Reviews settings', hideLabel: true, items: [item('settings', 'Settings', <Settings {...NAV_ICON} />)] },
  ]

  const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-10)', padding: 'var(--nds-space-14)', border: '1px solid var(--nds-border-subtle)', borderRadius: 'var(--nds-radius-lg)', background: 'var(--nds-surface)', minWidth: 0 }
  const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-16)' }

  return (
    <section id="review-parts-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-16)', marginBottom: 'var(--nds-space-24)' }}>
      <h3>Reviews parts · stars, rating bars, link tiles, counter, marks, pinned navigation, page builder, reply, photos</h3>

      <div style={card}>
        <h4>StarRating</h4>
        {[0, 1.5, 3, 4.3, 4.7, 5].map(v => (
          <div key={v} style={row}>
            <span style={{ width: 'var(--nds-space-40)' }}>{v}</span>
            <StarRating value={v} size="sm" />
            <StarRating value={v} />
            <StarRating value={v} size="lg" />
          </div>
        ))}
        <div style={row}>
          <StarRating value={4.5} count={128} />
          <StarRating value={null} />
          <StarRating mode="input" value={stars} onChange={setStars} label="Your rating" />
          <span role="status">{stars == null ? 'No rating picked' : `${stars} of 5`}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--nds-space-16)' }}>
        <div style={card}><h4>RatingBars</h4><RatingBars counts={[82, 25, 8, 5, 8]} selected={bar} onSelect={setBar} /></div>
        <div style={card}><h4>Compact, a bar with none</h4><RatingBars compact counts={[41, 12, 0, 3, 9]} selected={1} onSelect={() => {}} /></div>
        <div style={card}><h4>Empty</h4><RatingBars counts={[0, 0, 0, 0, 0]} /></div>
      </div>

      <MetricStrip metrics={metrics} minTileWidth={132} />

      <Banner
        tone="warning"
        title="Sending is paused"
        onDismiss={() => {}}
        action={<><Button size="sm">Resume sending</Button><Button size="sm" variant="ghost">Run now</Button></>}
      >
        187 requests wait. Nothing is sent while sending is paused; the queue keeps filling.
      </Banner>

      <div style={card}>
        <h4>Textarea with a limit</h4>
        <label htmlFor="review-parts-note">Note (500 characters)</label>
        <Textarea id="review-parts-note" rows={3} limit={500} value={note} onChange={e => setNote(e.target.value)} />
        <Button size="sm" onClick={() => setNote('Too long. '.repeat(55))}>Fill past the limit</Button>
      </div>

      <div style={card}>
        <h4>Heatmap · the hour we send is outlined</h4>
        <Heatmap
          data={HEAT}
          rowLabels={DAYS}
          colLabels={HOURS}
          colTitles={HOUR_TITLES}
          marked={MARKED}
          emptyLabel="none sent at that hour"
          cellWords={(r, c, v) => `${DAYS[r]} ${HOUR_TITLES[c]}: ${v == null ? 'none sent at that hour' : `${Math.round(v * 100)}% left a review`}${MARKED.has(heatKey(r, c)) ? ' · we send at this hour' : ''}`}
        />
      </div>

      <div style={card}>
        <h4>Heatmap · theme names, cells open their reviews</h4>
        <Heatmap
          data={THEME_HEAT}
          rowLabels={THEMES}
          colLabels={THEME_DAYS.map((d, i) => (i % 3 === 0 ? d : ''))}
          colTitles={THEME_DAYS}
          labelWidth={120}
          label="When themes come up"
          emptyLabel="no reviews that day"
          cellWords={(r, c, v) => `${THEMES[r]}, ${THEME_DAYS[c]}: ${v == null ? 'no reviews that day' : `${v} mentions — open these reviews`}`}
          onCellClick={(r, c) => setHeatPick(`${THEMES[r]}, ${THEME_DAYS[c]}`)}
        />
        <p>{heatPick ? `Pressed: ${heatPick}` : 'Press a cell (or Tab to the map, then the arrows and Enter).'}</p>
      </div>

      <div style={card}>
        <h4>WorkspaceSubheader · pinned</h4>
        <div style={{ display: 'flex', minHeight: 420, border: '1px solid var(--nds-border)', '--nds-secondary-nav-pinned-h': '420px' } as CSSProperties}>
          <WorkspaceSubheader
            pinned
            chrome={chrome}
            title="Reviews"
            subtitle="All channels"
            navigationLabel="Reviews navigation"
            navigationId="review-parts-navigation"
            navigationOpen={navOpen}
            onNavigationOpenChange={setNavOpen}
            groups={groups}
            onNavigate={(event, destination) => { event.preventDefault(); setPage(destination.id) }}
          />
          <div style={{ flex: 1, minWidth: 0, padding: 'var(--nds-space-16)' }}>
            <Button size="sm" aria-haspopup="dialog" aria-expanded={navOpen} aria-controls="review-parts-navigation" onClick={() => setNavOpen(o => !o)}>Reviews</Button>
            <p>Page: {page}. Below 1024 px the column is gone and this button opens the navigation.</p>
          </div>
        </div>
      </div>

      <div style={card}>
        <h4>Builder · page mode</h4>
        <Checkbox label="A problem holds Save" checked={problem} onChange={e => setProblem(e.target.checked)} />
        <Builder
          mode="page"
          navLabel="Rule sections"
          sections={[
            { id: 'rp-basics', label: 'Basics', content: <div style={{ ...card, minHeight: 220 }}>Name and notes.</div> },
            { id: 'rp-who', label: 'Who', content: <div style={{ ...card, minHeight: 320 }}>Which orders this rule asks.</div> },
            { id: 'rp-when', label: 'When', badge: problem ? <Pill tone="danger">1</Pill> : undefined, content: <div style={{ ...card, minHeight: 280 }}>The day and hour of the first try.</div> },
            { id: 'rp-message', label: 'Message', content: <div style={{ ...card, minHeight: 160 }}>What the buyer gets.</div> },
          ]}
          aside={<div style={card}><strong>When it sends</strong><p>Live — follows your changes. Saved {saved} times.</p></div>}
          footer={dirty > 0 ? (
            <EditModeBar
              count={dirty}
              saveShortcut
              onDiscard={() => setDirty(0)}
              onApply={() => { setSaved(n => n + 1); setDirty(0) }}
              applyLabel="Save rule"
              applyHeldReason={problem ? 'Fix 1 problem in When first: the hour is outside every send window.' : null}
            />
          ) : <Button size="sm" onClick={() => setDirty(2)}>Make 2 changes</Button>}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--nds-space-16)' }}>
        <ReplyComposer
          title="Reply on a marketplace"
          label="Reply to Marco R."
          value={reply}
          onChange={setReply}
          limit={500}
          ruleLine="One reply per feedback, up to 500 characters, can't be edited or removed."
          templates={TEMPLATES}
          draft={{
            busy: drafting,
            englishLine: english,
            onDraft: () => {
              setDrafting(true)
              window.setTimeout(() => { setReply('Grazie Marco per il feedback! La giacca veste piccola: consigliamo una taglia in più.'); setEnglish('Thank you for the feedback, Marco! The jacket runs small: we suggest one size up.'); setDrafting(false) }, 900)
            },
          }}
          primary={{ label: 'Send reply', onClick: () => {} }}
          secondary={[{ label: 'Save draft', onClick: () => {} }]}
        />
        <ReplyComposer
          title="Reply on a marketplace"
          label="Reply to Hannah W."
          value=""
          onChange={() => {}}
          limit={null}
          ruleLine="The channel has no reply API: copy the reply and open the review there."
          window="Day 12 of 100"
          primary={{ label: 'Copy reply', onClick: () => {}, heldReason: "You need 'Manage reviews' to reply." }}
          secondary={[{ label: 'Open on the channel', href: 'https://nexus.invalid/review', external: true }]}
        />
        <ReplyComposer
          title="Reply on a marketplace"
          label="Reply to Felix B."
          value=""
          onChange={() => {}}
          limit={500}
          ruleLine="One reply per feedback, up to 500 characters, can't be edited or removed."
          sent={{ at: 'Sent 26 Oct 2026, 10:42', text: 'Thank you, Felix! Glad everything fitted. Ride safe!', note: '· public · cannot be undone or edited' }}
        />
      </div>

      <div style={row}>
        <div style={{ ...card, flex: '2 1 360px' }}>
          <h4>PerformanceGraph · bars under a line (a week without reviews is a gap in the line)</h4>
          <PerformanceGraph data={WEEK_ROWS} xKey="when" left={WEEK_BARS} right={WEEK_LINE} height={200} />
        </div>
        <div style={{ ...card, flex: '1 1 300px' }}>
          <h4>PerformanceGraph · stacked bars by type</h4>
          <PerformanceGraph data={TYPE_ROWS} xKey="when" left={TYPE_STACK} right={TYPE_LINE} height={200} />
        </div>
      </div>

      <div style={row}>
        <Button onClick={() => setLightbox(1)}>Open the photos (4)</Button>
        <Lightbox
          open={lightbox != null}
          onClose={() => setLightbox(null)}
          items={PHOTOS}
          index={lightbox ?? 0}
          onIndex={setLightbox}
          title={`Photo ${(lightbox ?? 0) + 1} of ${PHOTOS.length} · Jonas K.`}
          meta={<><StarRating value={3} size="sm" /> Jonas K. · 26 Oct 2026</>}
          caption="“Really waterproof, but runs very small. Shipping was quick.”"
          external={{ label: 'Open on the channel', href: 'https://nexus.invalid/review' }}
        />
      </div>
    </section>
  )
}
