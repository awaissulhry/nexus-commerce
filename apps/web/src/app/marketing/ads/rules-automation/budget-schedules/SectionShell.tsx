'use client'

/**
 * BSP.0 — the anchored collapsible section card, and the empty-state vocabulary the six sections
 * (and the seven sessions that fill them) inherit.
 *
 * ── The vocabulary ─────────────────────────────────────────────────────────────────────────────
 *
 * The brief asks for three states, and they exist because this page's tab currently renders the
 * FIRST one for all three: `BudgetScheduleTab.tsx:42` swallowed every error into an empty array, so
 * an API 500 and an account with no schedules were the same screen.
 *
 *   nothing-made   0 rows, engine healthy      "No … yet." + one sentence on what one does
 *   ran-nothing    rows exist, changed = 0     "Ran at HH:MM. Nothing to change."
 *   broke          the fetch threw, or FAILED  the actual error text, and when it started
 *
 * 🔴 A note for BSP.1–.7, because this vocabulary is inherited and changing it later is expensive:
 * `docs/2026-08-11-substrate-spec.md` §5.6 argues for a FOURTH state — **refused** (a `GateDecision`
 * deny or a cap refusal), on the grounds that a refusal is not breakage and must never be the same
 * colour as it. That spec is not adopted and its own note says refusals are unsourceable today —
 * cap refusals have persisted nowhere since 2026-08-04, they only publish into a five-minute ring
 * buffer. So `EmptyKind` is a union rather than a boolean pair: adding `'refused'` is one member,
 * one branch and one CSS rule, not a rewrite of six sections.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { ChevronDown, AlertTriangle } from 'lucide-react'
import { EmptyState } from '@/design-system/components'
import { NoDataIllus } from '../_shared/NoDataIllus'
import type { BspSection } from './urlState'

export type EmptyKind = 'nothing-made' | 'ran-nothing' | 'broke'

export function SectionEmpty({
  kind, noun, what, ranAt, error, since,
}: {
  kind: EmptyKind
  /** The object this section is about, e.g. "budget schedules". */
  noun: string
  /** One sentence on what one of them does. Shown only for `nothing-made`. */
  what?: string
  /** For `ran-nothing`: when the engine last ticked. */
  ranAt?: string | null
  /** For `broke`: the actual message. Never paraphrased into "something went wrong". */
  error?: string | null
  /** For `broke`: when it started failing, when that is known. */
  since?: string | null
}) {
  if (kind === 'broke') {
    return (
      <EmptyState
        className="h10-bsp-empty broke"
        icon={<AlertTriangle size={22} />}
        title={`${noun.charAt(0).toUpperCase()}${noun.slice(1)} could not be loaded.`}
        description={
          <>
            {error ?? 'The request failed and returned no message.'}
            {since ? <> Failing since {since}.</> : null}
          </>
        }
      />
    )
  }

  if (kind === 'ran-nothing') {
    return (
      <EmptyState
        className="h10-bsp-empty"
        icon={<NoDataIllus size={72} />}
        title={ranAt ? `Ran at ${ranAt}. Nothing to change.` : 'It ran. Nothing to change.'}
        description={`Every ${noun.replace(/s$/, '')} was evaluated and none of them matched.`}
      />
    )
  }

  return (
    <EmptyState
      className="h10-bsp-empty"
      icon={<NoDataIllus size={72} />}
      title={`No ${noun} yet.`}
      description={what}
    />
  )
}

/**
 * One section: an anchor, a heading, a one-line purpose, and a body.
 *
 * Collapsible and expanded by default. `?section=` scrolls this into view and forces it open —
 * ⚠ scrolling into view means `MAIN.h10-main`, measured as the app shell's real scroller. Calling
 * `window.scrollTo` here would do nothing at all, silently.
 */
export function SectionShell({
  id, heading, purpose, owner, open, onToggle, focused, children,
}: {
  id: BspSection
  heading: string
  purpose: string
  /** The session that fills this section. Named on screen: an operator should never wonder whether
   *  an empty section is broken or simply not built yet. */
  owner?: string
  open: boolean
  onToggle: () => void
  /** True when `?section=` names this one — scroll to it once, on mount. */
  focused: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!focused || !ref.current) return
    // The app shell scrolls `MAIN.h10-main`, not the window. `scrollIntoView` walks up to whatever
    // actually scrolls, which is why it is used here rather than a hand-computed offset — and
    // `block: 'start'` honours this element's `scroll-margin-top: 120px`, which is what lands it
    // under the pinned spine + band rather than behind them. Measured on prod: y = 120.2.
    //
    // 🔴 `behavior: 'auto'`, NOT 'smooth'. Smooth scrolling is driven by requestAnimationFrame, and
    // measured on production `?section=hours` left `scrollTop` at 0 while the identical call with
    // 'auto' moved it to 342. A deep link that silently does not scroll looks exactly like a deep
    // link that was ignored. (`html { scroll-behavior: smooth }` is set globally and does not
    // rescue it — the same rAF drives both.)
    ref.current.scrollIntoView({ block: 'start', behavior: 'auto' })
  }, [focused])

  return (
    <section id={`bsp-${id}`} ref={ref} className={`h10-bsp-sec${open ? ' open' : ''}`}>
      <button type="button" className="h10-bsp-sechd" onClick={onToggle} aria-expanded={open} aria-controls={`bsp-body-${id}`}>
        <ChevronDown size={15} className="chev" aria-hidden="true" />
        <span className="ttl">
          <b>{heading}</b>
          <i>{purpose}</i>
        </span>
        {owner && <span className="own">{owner}</span>}
      </button>
      {open && <div className="h10-bsp-secbd" id={`bsp-body-${id}`}>{children}</div>}
    </section>
  )
}

/**
 * The body of a section that has not been built yet.
 *
 * Distinct from `SectionEmpty` on purpose: "nobody has made one" and "this screen does not exist
 * yet" are different facts, and rendering the first for the second is exactly the lie this page is
 * being rebuilt to stop telling.
 */
export function SectionPending({ session, what }: { session: string; what: string }) {
  return (
    <div className="h10-bsp-pending">
      <b>Not built yet — {session}.</b>
      <span>{what}</span>
    </div>
  )
}
