'use client'

/**
 * /design/chrome — CH.1 lane, wave-4 design §4.2. THE TWO CHROME OPTIONS, MOCKED.
 *
 * This page decides nothing. It renders Option A and Option B side by side at the two measured
 * widths so the Owner can pick, and it shows every number from §4.1 on screen rather than in a
 * commentary. Measurements and their causes: `docs/2026-09-02-chrome-proposal.md`.
 *
 * ── The finding that shapes both mocks ───────────────────────────────────────────────────────
 *
 * The per-page header ALREADY scrolls away, on every page, today. Nothing in the chrome is
 * `fixed` or `sticky`: the bar persists only because `.nds-chrome-host` is
 * `height:100dvh; overflow:hidden` and just the content pane scrolls. Measured on
 * /dashboard/overview at 1728x906 by scrolling `#main-content` 500px — top-of-content moved
 * -500.0px, `.nds-topbar` 0.0px, `.h10-rail` 0.0px.
 *
 * So Option A is NOT "make the header scroll away". It is "delete the 56px band and rehouse its
 * four controls in the rail". Both mocks below scroll their page header away, because both do
 * today; the difference between them is the 56px band and the alignment grid.
 *
 * ── Why the stage is scaled ─────────────────────────────────────────────────────────────────
 *
 * The shared Chrome window is 1728x906 and CH.1 must not resize it (other lanes are in it). Each
 * mock therefore renders at TRUE CSS pixel size (1440 or 1728 wide, 906 tall) inside a wrapper
 * that scales it to fit. Geometry is real; only the viewing scale is not, and it is printed on
 * screen. Every offset drawn by the guides is computed from the same constants measured in 4.1.
 *
 * ── DS ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Chrome surfaces use `--nds-chrome-*` (theme-independent literals, tokens/chrome.ts); page
 * surfaces use `--nds-surface` / `--nds-text` / `--nds-border`, which flip under `.dark`. No
 * literal colours, and no question-mark cursor anywhere (scripts/check-help-cursor.mjs greps
 * comments as well as code, so the banned phrase is not spelled out here either). The dark
 * toggle wraps the stage in `.dark` so the PAGE surfaces flip while chrome stays dark by
 * design — the same behaviour as the real app.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Search, Bell, Sun, Home, Package, Layers, Boxes, Truck, ShoppingCart,
  Tag as TagIcon, BarChart3, Megaphone, ChevronLeft,
} from 'lucide-react'
import { Button, SegmentedControl, ToolbarButton, Kbd } from '@/design-system/primitives'
import { SearchTrigger, KeyValue } from '@/design-system/components'
import css from './chrome.module.css'

/*
 * ── DS controls on dark chrome, WITHOUT forking anything ─────────────────────────────────────
 *
 * Every control below is a DS component. The DS's field and button surfaces are LIGHT, so on the
 * dark chrome they render as bright blobs — that is `.claude/DS-GAPS.md` §TB (2026-08-31,
 * still OPEN): "no DS control has a variant for sitting on dark chrome".
 *
 * The gap entry also records the sanctioned workaround, and `app-topbar.css` already implements
 * it: re-surface via `--nds-chrome-control-*`, scoped to `.nds-topbar`, without forking geometry,
 * radius or focus. That stylesheet is loaded app-wide by `components/layout/AppShell.tsx`.
 *
 * So this lab REUSES those rules rather than copying them into a second stylesheet — a copy is
 * exactly the stylesheet fork the DS fork-drift guard cannot see. `ChromeScope` is a
 * `display: contents` element carrying the class: it contributes no box of its own (so the bar's
 * height/background/z-index never apply), but it is a DOM ancestor, so `.nds-topbar .nds-field`
 * and friends match the DS controls inside it. Zero new CSS, zero duplication.
 */
function ChromeScope({ children }: { children: React.ReactNode }) {
  return <div className="nds-topbar" style={{ display: 'contents' }}>{children}</div>
}

/* ── constants: every one of these is a MEASURED number from §4.1 ───────────────────────────── */
const M = {
  topbarH: 56,          // --nds-topbar-h
  railW: 66,            // .h10-rail width, == --nds-topbar-brand-w
  railExpanded: 344,    // .h10-rail:hover
  fieldW: 496,          // .nds-topbar-field measured width
  fieldH: 36,           // --nds-topbar-slot-h
  utilityW: 109,        // .nds-topbar-utility measured width
  barPad: 12,           // .nds-topbar-* padding: 0 12px
  gutterApp: 24,        // AppShell `p-3 md:p-6`
  gutterH10: 30,        // .h10-main padding: 26px 30px
  gutterStudio: 0,      // .h10-shell padding-left:66px, no gutter
  gridGutter: 24,       // the ONE gutter, under either option
  sheetGutter: 0,       // 🔴 the sheet exception — see gutterFor()
} as const

/**
 * The gutter a page gets — the one grid, plus the one named exception.
 *
 * PES.0 ruling #529: a sheet page keeps **0 side gutters under either option**. A sheet's edge is
 * the viewport's edge, every pixel is a column, and GridSheet already makes the sheet the page.
 * This is a deliberate rule, not a cost A or B imposes — which is why the studio stage renders
 * flush in BOTH mocks, and the Owner compares like with like.
 */
function gutterFor(scenario: Scenario): number {
  return scenario === 'studio' ? M.sheetGutter : M.gridGutter
}

const WIDTHS = [1440, 1728] as const
type Width = (typeof WIDTHS)[number]
type Scenario = 'studio' | 'list' | 'narrow'
type Option = 'A' | 'B'

const SCENARIOS: { id: Scenario; label: string; note: string }[] = [
  { id: 'studio', label: 'Studio · sheet at max scroll', note: '906 tall, scrolled to the bottom' },
  { id: 'list', label: 'List (/products/next)', note: 'the grid page' },
  { id: 'narrow', label: 'Narrow page (mapping)', note: 'a form-width page' },
]

const NAV = [
  { icon: Home, label: 'Home' }, { icon: Package, label: 'Products' },
  { icon: Layers, label: 'Listings' }, { icon: Boxes, label: 'Stock' },
  { icon: Truck, label: 'Inbound' }, { icon: ShoppingCart, label: 'Orders' },
  { icon: TagIcon, label: 'Pricing' }, { icon: BarChart3, label: 'Insights' },
  { icon: Megaphone, label: 'Advertising' },
]

/* ── the vertical ledger, per page, per option ──────────────────────────────────────────────── */
const LEDGER = [
  { page: 'studio',          today: 0,  a: 0,  b: 0 },
  { page: '/products/next',  today: 56, a: 0,  b: 56 },
  { page: 'mapping',         today: 56, a: 0,  b: 56 },
  { page: 'ads',             today: 56, a: 0,  b: 56 },
  { page: 'dashboard',       today: 56, a: 0,  b: 56 },
]

/* ── the horizontal effect of Option B's one grid (gutter 24) ───────────────────────────────── */
const H_LEDGER = [
  { page: 'studio (sheet)', now: 66,  next: 66, note: 'unchanged — the sheet exception, under BOTH options' },
  { page: '/products/next', now: 96,  next: 90, note: 'gains 6px each side' },
  { page: 'mapping',        now: 90,  next: 90, note: 'unchanged — already on the grid' },
  { page: 'ads',            now: 96,  next: 90, note: 'gains 6px each side' },
  { page: 'dashboard',      now: 197, next: 90, note: '@1728 only; the max-w cap goes' },
]

/* ══ shared mock pieces ═════════════════════════════════════════════════════════════════════ */

function RailNav({ expanded }: { expanded: boolean }) {
  return (
    <nav aria-label="Mock navigation" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px' }}>
      {NAV.map(({ icon: Icon, label }, i) => (
        <a
          key={label}
          href="#"
          onClick={(e) => e.preventDefault()}
          style={{
            display: 'flex', alignItems: 'center', gap: 12, height: 40, borderRadius: 10,
            padding: '0 11px', textDecoration: 'none', whiteSpace: 'nowrap',
            color: i === 1 ? 'var(--nds-chrome-fg-strong)' : 'var(--nds-chrome-fg)',
            background: i === 1 ? 'var(--nds-chrome-item-hover)' : 'transparent',
          }}
        >
          <Icon size={18} style={{ flex: 'none' }} aria-hidden />
          <span className={css.mdMinus} style={{ fontWeight: 600, opacity: expanded ? 1 : 0 }}>{label}</span>
        </a>
      ))}
    </nav>
  )
}

/**
 * The search control — the DS `SearchTrigger`, which is what the real `AppTopBar` uses.
 *
 * It only dispatches `nexus:open-command-palette`; the field is a trigger, never a second search.
 * `nds-topbar-field` is the real bar's own layout class (width 100%, height --nds-topbar-slot-h),
 * reused here so the mock's field is the bar's field rather than a lookalike.
 */
function ChromeField({ width, placeholder }: { width: number | string; placeholder: string }) {
  return (
    <div style={{ width }}>
      <SearchTrigger
        className="nds-topbar-field"
        placeholder={placeholder}
        ariaLabel="Search — opens the command palette"
        icon={<Search size={15} />}
        onOpen={() => {}}
        adornment={<><Kbd>⌘</Kbd><Kbd>K</Kbd></>}
      />
    </div>
  )
}

function Avatar() {
  return (
    <span
      aria-hidden
      className={css.micro}
      style={{
        width: 22, height: 22, flex: 'none', borderRadius: 'var(--nds-radius-round)',
        background: 'var(--nds-primary)', color: 'var(--nds-white)', fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      AS
    </span>
  )
}

/**
 * Profile — the DS `Button` wearing the real bar's own `nds-topbar-profile` class, so it is the
 * bar's control rather than a copy of it (height --nds-topbar-slot-h, chrome control surface).
 */
function ProfileButton({ showName }: { showName?: boolean }) {
  return (
    <Button variant="secondary" size="sm" className="nds-topbar-profile" aria-label="Profile — Owner">
      <Avatar />
      {showName && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Owner</span>}
    </Button>
  )
}

/** The page body. `gutter` is what the option's grid gives it. */
function PageBody({
  scenario, gutter, width, chromeTop, maxScroll,
}: { scenario: Scenario; gutter: number; width: number; chromeTop: number; maxScroll: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  // "the sheet at max scroll" — set it after mount, so the mock shows the state being judged.
  // useEffect, not useLayoutEffect: this component is SSR'd, and a layout effect logs a warning there.
  useEffect(() => {
    const el = ref.current
    if (el && maxScroll) el.scrollTop = el.scrollHeight
  }, [maxScroll, scenario, width, gutter])

  const rows = scenario === 'studio' ? 34 : scenario === 'list' ? 26 : 9

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', left: M.railW, top: chromeTop, right: 0, bottom: 0,
        overflowY: 'auto', background: 'var(--nds-bg)',
      }}
    >
      {/* the page's own header — inside the scroller, so it scrolls away. This is true TODAY. */}
      <div style={{ padding: `${gutter}px ${gutter}px 0` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 16 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {scenario === 'studio' && (
              <a href="#" onClick={(e) => e.preventDefault()}
                 className={css.sm}
                 style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                          color: 'var(--nds-text-2)', textDecoration: 'none', marginBottom: 4 }}>
                <ChevronLeft size={13} aria-hidden />Products
              </a>
            )}
            <h1 className={css.lg} style={{ margin: 0, fontWeight: 650, color: 'var(--nds-text)' }}>
              {scenario === 'studio' ? 'XAVIA GALE Giacca Da Moto Da Uomo' : scenario === 'list' ? 'Products' : 'Channel mapping'}
            </h1>
            <div className={css.sm} style={{ color: 'var(--nds-text-2)', marginTop: 2 }}>
              {scenario === 'studio' ? 'GALE-JACKET · B0F7J163X' : scenario === 'list' ? '4,182 products' : 'Amazon DE · de'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
            <Button variant="secondary" size="sm">Export</Button>
            <Button variant="primary" size="sm">Publish</Button>
          </div>
        </div>
      </div>

      {/* body */}
      <div style={{ padding: `0 ${gutter}px ${gutter}px` }}>
        <div style={{ border: '1px solid var(--nds-border)', borderRadius: 'var(--nds-radius-lg)',
                      overflow: 'hidden', background: 'var(--nds-surface)' }}>
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className={css.sm} style={{
              display: 'flex', alignItems: 'center', gap: 16, height: 34, padding: '0 12px',
              color: 'var(--nds-text-2)',
              borderTop: i ? '1px solid var(--nds-border-subtle)' : undefined,
              background: i === rows - 1 && maxScroll ? 'var(--nds-primary-soft)' : undefined,
            }}>
              <span style={{ width: 120, color: 'var(--nds-text)' }}>
                {scenario === 'studio' ? ['bullet_point', 'brand', 'colour', 'size', 'material'][i % 5] : `SKU-${1000 + i}`}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {i === rows - 1 && maxScroll ? '▲ last row — sheet at max scroll' : 'value '.repeat(6)}
              </span>
              <span style={{ width: 70, textAlign: 'right' }}>{(i * 7) % 100}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ══ OPTION A — full-height sidebar from the top-left; no top bar ═══════════════════════════ */

function MockA({ scenario, width, expanded, guides }: { scenario: Scenario; width: Width; expanded: boolean; guides: boolean }) {
  const railW = expanded ? M.railExpanded : M.railW
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--nds-bg)' }}>
      {/* the sidebar owns brand, search, nav, identity — full height from y=0 */}
      <aside
        aria-label="Mock sidebar (Option A)"
        style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: railW, zIndex: 50,
          background: 'var(--nds-chrome-bg)', borderRight: '1px solid var(--nds-chrome-border)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: expanded ? 'var(--nds-chrome-shadow-rail)' : undefined,
        }}
      >
        {/* brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: M.topbarH, padding: '0 19px', flex: 'none' }}>
          <span aria-hidden style={{ width: 28, height: 28, flex: 'none', borderRadius: 'var(--nds-radius-md)',
                    background: 'var(--nds-primary)', color: 'var(--nds-white)', fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                className={css.md}>N</span>
          <span className={css.lg} style={{ fontWeight: 700, color: 'var(--nds-chrome-fg-strong)',
                         whiteSpace: 'nowrap', opacity: expanded ? 1 : 0 }}>Nexus</span>
        </div>

        {/* global search — the whole point of A's sidebar carrying it */}
        <ChromeScope>
        <div style={{ padding: expanded ? '4px 19px 10px' : '4px 15px 10px', flex: 'none' }}>
          {expanded ? (
            <ChromeField width={M.railExpanded - 38} placeholder="Jump to anything…" />
          ) : (
            <ToolbarButton icon={<Search size={15} />} label="Search — opens the command palette" />
          )}
        </div>
        </ChromeScope>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}><RailNav expanded={expanded} /></div>

        {/* identity + utility, at the foot of the sidebar */}
        <ChromeScope>
        <div style={{ flex: 'none', borderTop: '1px solid var(--nds-chrome-border)', padding: 8,
                      display: 'flex', alignItems: 'center', gap: 8,
                      justifyContent: expanded ? 'flex-start' : 'center', flexWrap: 'nowrap' }}>
          <ProfileButton showName={expanded} />
          {/* Only when expanded: three controls do not fit the 66px collapsed rail — they
              overflow it. The DS swap briefly dropped these guards and the foot spilled. */}
          {expanded && <span style={{ flex: 1 }} />}
          {expanded && <ToolbarButton icon={<Sun size={16} />} label="Switch theme" />}
          {expanded && <ToolbarButton icon={<Bell size={16} />} label="Notifications" />}
        </div>
        </ChromeScope>
      </aside>

      {/*
        Content comes AFTER the sidebar in the DOM, not before.

        This is the focus order, and it is Option A's stated consequence ("sidebar first"). Paint
        order is unaffected: the sidebar is `position:absolute; z-index:50`, so it still draws over
        the content when it expands to 344. The first pass had the content first and tabbed
        page → sidebar, which is the opposite of what A claims — caught by walking the tab order
        rather than reading the markup.
      */}
      <PageBody scenario={scenario} gutter={gutterFor(scenario)} width={width} chromeTop={0} maxScroll={scenario === 'studio'} />

      {/* the SAME grid as B — so the two options are compared on one ruler, not two */}
      {guides && <Guides width={width} chromeTop={0} gutter={gutterFor(scenario)} />}
    </div>
  )
}

/* ══ OPTION B — the bar kept; every 4.1 delta removed by ONE grid ═══════════════════════════ */

function MockB({ scenario, width, guides }: { scenario: Scenario; width: Width; guides: boolean }) {
  const g = gutterFor(scenario)
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--nds-bg)' }}>
      {/* the bar: same 56px, but on the grid */}
      <header
        role="banner"
        style={{
          position: 'absolute', left: 0, top: 0, width: '100%', height: M.topbarH, zIndex: 60,
          display: 'flex', alignItems: 'center', background: 'var(--nds-chrome-bg)',
          // D7 fixed: the rule is drawn OUTSIDE the 56px box, so children centre on 28, not 27.5
          boxShadow: 'inset 0 -1px 0 var(--nds-chrome-border)',
        }}
      >
        <div style={{ width: M.railW, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span aria-hidden style={{ width: 28, height: 28, borderRadius: 'var(--nds-radius-md)',
                    background: 'var(--nds-primary)', color: 'var(--nds-white)', fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                className={css.md}>N</span>
        </div>
        {/* D3 fixed: the context slot starts at the CONTENT's left edge (90), not 78 */}
        <div style={{ flex: 1, minWidth: 0, paddingLeft: g, display: 'flex', alignItems: 'center' }}>
          <span className={css.base} style={{ fontWeight: 550, color: 'var(--nds-chrome-fg-strong)' }}>
            {scenario === 'studio' ? 'XAVIA GALE — Amazon DE' : scenario === 'list' ? 'Products' : 'Channel mapping'}
          </span>
        </div>
        {/* D4/D5 fixed: the field's RIGHT edge is pinned to the content's right edge */}
        <ChromeScope>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, paddingRight: g }}>
          <ChromeField width={M.fieldW} placeholder="Jump to anything…" />
          <span aria-hidden style={{ width: 1, height: 20, background: 'var(--nds-chrome-control-border)' }} />
          <ProfileButton />
          <ToolbarButton icon={<Sun size={16} />} label="Switch theme" />
          <ToolbarButton icon={<Bell size={16} />} label="Notifications" />
        </div>
        </ChromeScope>
      </header>

      <aside
        aria-label="Mock rail (Option B)"
        style={{
          position: 'absolute', left: 0, top: M.topbarH, bottom: 0, width: M.railW, zIndex: 50,
          background: 'var(--nds-chrome-bg)', borderRight: '1px solid var(--nds-chrome-border)', overflow: 'hidden',
        }}
      >
        <RailNav expanded={false} />
      </aside>

      {/* bar → rail → content: the order AppShell itself renders, so the focus order matches. */}
      <PageBody scenario={scenario} gutter={g} width={width} chromeTop={M.topbarH} maxScroll={scenario === 'studio'} />

      {/* the one grid, drawn: both rules land on the same x on every page */}
      {guides && <Guides width={width} chromeTop={M.topbarH} gutter={gutterFor(scenario)} />}
    </div>
  )
}

/**
 * The one grid, drawn.
 *
 * `zIndex` 70 is deliberate and must stay above the bar's 60: the first cut rendered the overlay
 * with no z-index at all, so the bar painted over the labels and the guides were invisible on
 * exactly the option whose whole pitch is "one grid". Labels sit below `labelTop` for the same
 * reason.
 */
function Guides({ width, chromeTop, gutter }: { width: number; chromeTop: number; gutter: number }) {
  const left = M.railW + gutter
  const right = width - gutter
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 70 }}>
      <Rule x={left} label={`content left ${left}`} top={chromeTop + 4} />
      <Rule x={right} label={`content right ${right}`} top={chromeTop + 4} flip />
    </div>
  )
}

function Rule({ x, label, top, flip }: { x: number; label: string; top: number; flip?: boolean }) {
  return (
    <>
      <div style={{ position: 'absolute', left: x, top: 0, bottom: 0, width: 1,
                    background: 'var(--nds-primary)', opacity: 0.55 }} />
      <span
        className={css.micro}
        style={{
          position: 'absolute', top, left: flip ? x - 4 : x + 4,
          transform: flip ? 'translateX(-100%)' : undefined,
          whiteSpace: 'nowrap', letterSpacing: '0.02em',
          color: 'var(--nds-white)', background: 'var(--nds-primary)',
          padding: '1px 4px', borderRadius: 3,
        }}
      >
        {label}
      </span>
    </>
  )
}

/* ══ the lab ════════════════════════════════════════════════════════════════════════════════ */

export default function ChromeLabPage() {
  const [option, setOption] = useState<Option>('A')
  const [scenario, setScenario] = useState<Scenario>('studio')
  const [width, setWidth] = useState<Width>(1440)
  const [dark, setDark] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [guides, setGuides] = useState(true)
  const [scale, setScale] = useState(1)
  const [fitMode, setFitMode] = useState<'fit' | 'full'>('fit')
  const hostRef = useRef<HTMLDivElement>(null)

  const H = 906

  /*
   * Fit the true-size stage into the room the lab has — in BOTH axes.
   *
   * Width alone is not enough: the stage is 906 tall, the shared window is 906 tall, and the
   * lab's own header eats ~290 of it, so a width-only fit puts the bottom third of every mock
   * below the fold. The vertical budget is the thing being judged, so 'fit' sizes to height too.
   * 'full' pins 1:1 for reading detail, and the live percentage is printed either way.
   */
  useEffect(() => {
    const fit = () => {
      const el = hostRef.current
      if (!el) return
      if (fitMode === 'full') { setScale(1); return }
      const top = el.getBoundingClientRect().top
      const availH = window.innerHeight - top - 16
      setScale(Math.max(0.3, Math.min(1, (el.clientWidth - 2) / width, availH / H)))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [width, fitMode])
  const gain = option === 'A' ? 56 : 0

  return (
    <div className={css.page} style={{ padding: 24, color: 'var(--nds-text)' }}>
      <h1 className={css.xl} style={{ margin: '0 0 4px', fontWeight: 650 }}>App chrome — the two options</h1>
      <p className={css.base} style={{ color: 'var(--nds-text-2)', margin: '0 0 4px', maxWidth: 860 }}>
        CH.1, wave-4 design §4.2. Measurements and causes: <code>docs/2026-09-02-chrome-proposal.md</code>.
        Each stage renders at true CSS pixel size ({width}×{H}) and is scaled to fit — geometry is real,
        the viewing scale is not.
      </p>
      <p className={css.smPlus} style={{ color: 'var(--nds-text-2)', margin: '0 0 16px', maxWidth: 860 }}>
        <strong style={{ color: 'var(--nds-text)' }}>Both mocks scroll their page header away</strong>, because
        every page already does that today — measured, §1.3. The difference between A and B is the 56px band
        and the alignment grid, nothing else.
      </p>

      {/* controls — focus order is the DOM order: option → scenario → width → theme → rail */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 14 }}>
        <Seg label="Option" value={option} onChange={setOption}
             options={[{ v: 'A' as const, l: 'A — sidebar to the top' }, { v: 'B' as const, l: 'B — bar kept, one grid' }]} />
        <Seg label="Scenario" value={scenario} onChange={setScenario}
             options={SCENARIOS.map((s) => ({ v: s.id, l: s.label }))} />
        <Seg label="Width" value={width} onChange={setWidth}
             options={WIDTHS.map((w) => ({ v: w, l: `${w}` }))} />
        <Seg label="Theme" value={dark} onChange={setDark}
             options={[{ v: false, l: 'Light' }, { v: true, l: 'Dark' }]} />
        <Seg label="Sidebar" value={expanded} onChange={setExpanded}
             options={[{ v: false, l: '66 collapsed' }, { v: true, l: '344 expanded' }]} />
        <Seg label="Zoom" value={fitMode} onChange={setFitMode}
             options={[{ v: 'fit' as const, l: 'Fit' }, { v: 'full' as const, l: '1:1' }]} />
        <Seg label="Grid" value={guides} onChange={setGuides}
             options={[{ v: true, l: 'Guides on' }, { v: false, l: 'Off' }]} />
        <span className={css.xsPlus} style={{ color: 'var(--nds-text-3)' }}>
          scale {(scale * 100).toFixed(0)}% · vertical gain vs today: <strong style={{ color: gain ? 'var(--nds-success)' : 'var(--nds-text-2)' }}>{gain ? `+${gain}px` : '0px'}</strong>
        </span>
      </div>

      {/* the stage */}
      <div ref={hostRef} style={{ width: '100%', overflow: 'hidden' }}>
        <div style={{ width, height: H, transform: `scale(${scale})`, transformOrigin: 'top left',
                      marginBottom: (scale - 1) * H }}>
          <div
            className={dark ? 'dark' : undefined}
            style={{ position: 'relative', width, height: H, overflow: 'hidden',
                     border: '1px solid var(--nds-border-strong)', borderRadius: 'var(--nds-radius-lg)',
                     background: 'var(--nds-bg)' }}
          >
            {option === 'A'
              ? <MockA scenario={scenario} width={width} expanded={expanded} guides={guides} />
              : <MockB scenario={scenario} width={width} guides={guides} />}
          </div>
        </div>
      </div>

      {/* the numbers */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, marginTop: 24 }}>
        <Ledger
          title="Vertical budget — px of chrome each page pays"
          items={LEDGER.map((r) => ({ label: r.page, value: `today ${r.today} → A ${r.a} · B ${r.b}` }))}
          foot="A returns 56px to four of five pages; the studio already pays 0, so it gains nothing. B gains nothing anywhere."
        />
        <Ledger
          title="Content left edge, today → one grid"
          items={H_LEDGER.map((r) => ({ label: r.page, value: `${r.now} → ${r.next}`, hint: r.note }))}
          foot="The one grid moves three pages by 6px or less. A sheet page keeps 0 side gutters under EITHER option (PES.0 ruling #529): a sheet’s edge is the viewport’s edge and every pixel is a column, so this is a named rule, not a cost either option imposes. No dense variant is needed."
        />
      </div>
    </div>
  )
}

/**
 * A labelled DS `SegmentedControl`.
 *
 * `SegmentedControl` speaks `string` values, so the generic maps to and from strings at this
 * boundary rather than every call site hand-rolling a group of raw button elements — which is
 * what this was, and what the raw-primitive ratchet correctly objected to. (The ratchet greps
 * comments as well as code, so the tag names are described here rather than spelled.)
 */
function Seg<T extends string | number | boolean>({
  label, value, onChange, options,
}: { label: string; value: T; onChange: (v: T) => void; options: { v: T; l: string }[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className={css.xs} style={{ fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                                                    color: 'var(--nds-text-3)' }}>{label}</span>
      <SegmentedControl
        ariaLabel={label}
        value={String(value)}
        options={options.map((o) => ({ value: String(o.v), label: o.l }))}
        onChange={(next) => {
          const hit = options.find((o) => String(o.v) === next)
          if (hit) onChange(hit.v)
        }}
      />
    </div>
  )
}

/**
 * A ledger — the DS `KeyValue`, not a grid.
 *
 * 🔴 WHY NOT A GRID, measured (PES.0 #632, `check-grid-kit-ratchet`). This was a hand-rolled
 * table element, then briefly the DS `DataGrid` — and `DataGrid` is a RETIRING kit the grid-kit
 * ratchet counts as rebuild backlog, so that swap moved between two backlog items rather than off
 * the backlog. The ratchet's preferred primitive is `NexusGrid`, and that is the wrong instrument
 * here by a wide margin:
 *
 *   NexusGrid  → `ag-grid-react` + `ag-grid-community`, a 7,090-line grid subsystem, its own
 *                stylesheet, and `registerGridModules()` at module scope registering **38 AG
 *                modules** as an import side effect.
 *   the payload → 2 ledgers, 10 rows, 4 columns, **40 cells, every one a literal string**, with
 *                no sort, filter, selection, editing or virtualisation, and none wanted.
 *
 * So the ledgers stop being a table at all. `KeyValue` is what the DS ships for "a set of
 * labelled values": a real `<dl>`, with `hint` for the per-row note. The full 4-column matrix
 * lives in `docs/2026-09-02-chrome-proposal.md` §6.2–6.3, which is where a finding stays visible.
 *
 * The gap this exposes is filed rather than worked around: the DS has **no lightweight static
 * table** — `DataGrid` is retiring, `NexusGrid` is an engine, and `KeyValue` is two columns, so a
 * small 4-column comparison has nothing to land on.
 */
function Ledger({ title, items, foot }: {
  title: string
  items: { label: string; value: string; hint?: string }[]
  foot: string
}) {
  return (
    <div style={{ minWidth: 380, flex: '1 1 380px', maxWidth: 620 }}>
      <h2 className={css.base} style={{ margin: '0 0 8px', fontWeight: 650 }}>{title}</h2>
      <KeyValue dense items={items} />
      <p className={css.xsPlus} style={{ color: 'var(--nds-text-2)', marginTop: 8 }}>{foot}</p>
    </div>
  )
}
