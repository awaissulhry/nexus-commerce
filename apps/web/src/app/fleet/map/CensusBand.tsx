'use client'

/**
 * NAF.SB.M-S1R — Section 1, the census band.
 *
 * Study: docs/2026-08-08-naf-sbm-s1-census-strip.md. It replaces the census
 * strip, and every decision in it is answering a measurement taken on the
 * deployed build at 1728×906 on 2026-08-08. The five that shaped this file:
 *
 * 1. **1063px of the old card was empty — 65.9%** — and the waste GREW with the
 *    viewport (52.7% at 1280 → 69.5% at 1920), because two shrink-wrapped
 *    children in a `space-between` row have no mechanism to use the middle. The
 *    fix is not "wider chips": it is putting a **width-absorbing element**
 *    between the two short ones. That is the meter, and it is the only child
 *    here that wants to be wide.
 * 2. **Every lens the census can ever draw fits on one line at 1037.3px**, in a
 *    1614px card. There was never a width problem — there was a layout that
 *    refused width and stacked into three rows inside a 270.7px column.
 * 3. **Nothing distinguished a pressed lens from an unpressed one.** Fill
 *    1.11:1, border 1.40:1, text 1.10:1, boundary 1.28:1 — three channels
 *    changing at once and not one reaching half of WCAG 1.4.11's 3:1 floor, so
 *    the state was carried by `aria-pressed` alone. Now: an inverted fill, a
 *    check glyph, and the word — Carbon's "at least three of these elements".
 * 4. **Pressing a lens moved the canvas 29.3px**, because the filter summary
 *    was inserted as a new block below the card. This page's own law is
 *    *filtering dims, it never re-lays-out* — it held inside the canvas and was
 *    broken from outside it. The summary now lands in the verdict's sub-line,
 *    which is **reserved whether or not a filter is on**.
 * 5. **A lens that can only produce nothing is not a lens.** Pressing
 *    `0 waiting in Approvals` dimmed all seven nodes and reported `0 of 7`.
 *    A zero count now renders as a *note* with its cause, never a button —
 *    Cloudscape's rule, that a state with no recourse must not offer one.
 *
 * THE COUNTING INVARIANT IS UNCHANGED AND UNCHANGEABLE. Every number here comes
 * from `census()`, which filters by the same `matches` the canvas dims by, and
 * `lib.vitest.test.ts` asserts the identity, the partition and the sum. The
 * meter's licence is that partition test: if the state chips ever stop
 * partitioning, a bar drawn from their proportions is a lie and must be deleted
 * in the same commit that breaks it.
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Activity, AlertTriangle, Check, HelpCircle, Power, PowerOff, ShieldAlert } from 'lucide-react'
import { Def, DEFINITIONS } from './definitions'
import {
  census,
  diagnosticFootnote,
  filterSummary,
  findingsTotals,
  usd,
  verdict,
  type MapNode,
  type VerdictTone,
} from './lib'

const TONE_ICON: Record<VerdictTone, ReactNode> = {
  halted: <ShieldAlert size={15} aria-hidden />,
  running: <Activity size={15} aria-hidden />,
  failed: <AlertTriangle size={15} aria-hidden />,
  off: <PowerOff size={15} aria-hidden />,
  mixed: <Power size={15} aria-hidden />,
  empty: <HelpCircle size={15} aria-hidden />,
}

export function CensusBand({
  nodes,
  halted,
  spentTodayUSD,
  dailyCeilingUSD,
  activeChip,
  onChip,
  onExplain,
}: {
  nodes: MapNode[]
  halted: boolean
  spentTodayUSD: number
  dailyCeilingUSD: number
  activeChip: string | null
  onChip: (id: string | null) => void
  /** Opens the teaching drawer at "What each number counts". The definitions
   *  are NOT tooltip-only: NN/g's line is that a tooltip must not carry what
   *  the task needs, and what a number counts *is* the number. */
  onExplain: () => void
}) {
  const rows = census(nodes)
  const v = verdict(nodes, halted)
  const totals = findingsTotals(nodes)
  const skew = diagnosticFootnote(nodes)

  const states = rows.filter((r) => r.chip.rank === 'state')
  const facts = rows.filter((r) => r.chip.rank === 'fact')

  /** A lens is a control only when pressing it leaves something on the canvas.
   *  Everything else that must still be said is said as a note. */
  const lenses = [...states, ...facts].filter((r) => r.count > 0)
  const notes = [...states, ...facts].filter(
    (r) =>
      r.count === 0 &&
      r.chip.alwaysRender === true &&
      r.chip.zeroNote != null &&
      // The verdict already says nothing is running when the fleet is off or
      // halted; a note repeating it would be the section's only duplicated
      // sentence.
      !(r.chip.id === 'running' && (v.tone === 'off' || v.tone === 'halted')),
  )

  const meterLabel =
    states
      .filter((r) => r.count > 0)
      .map((r) => `${r.count} ${r.chip.label}`)
      .join(', ') || 'nothing to show yet'

  /* Roving tabindex. The APG puts the threshold for a toolbar at "3 or more
     controls"; this section had five separate tab stops and would have had
     eleven at full population, reached after 35 stops of app chrome.

     The remembered index is the LAST FOCUSED control, not the active filter —
     tabbing away and back must land where you left, which is the half of the
     pattern that is easy to skip and is the whole reason it is nicer than five
     tab stops. It is clamped on every render because a poll can change which
     lenses exist underneath it. */
  const bar = useRef<HTMLDivElement | null>(null)
  const [focusIdx, setFocusIdx] = useState(0)
  const rovingIndex = Math.min(focusIdx, Math.max(lenses.length - 1, 0))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    const items = Array.from(bar.current?.querySelectorAll<HTMLButtonElement>('.sbm-lens') ?? [])
    if (items.length === 0) return
    const here = Math.max(items.indexOf(document.activeElement as HTMLButtonElement), 0)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (here + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length
    e.preventDefault()
    setFocusIdx(next)
    items[next]?.focus()
  }

  return (
    <section className={`sbm-band tone-${v.tone}`} aria-label="Is anything wrong, and is anything on">
      <div className="sbm-verdict">
        <p className="sbm-verdict-head">
          {TONE_ICON[v.tone]}
          <span>{v.headline}</span>
        </p>
        {/* Reserved, always. This row is where the filter summary lands, and a
            row that appears on click is a row that moves the graph. */}
        <p className="sbm-verdict-sub" role="status">
          {activeChip ? (
            <>
              {filterSummary(nodes, activeChip)}. The rest are dimmed, not hidden.{' '}
              <button type="button" className="sbm-linkbtn" onClick={() => onChip(null)}>
                Show all
              </button>
            </>
          ) : (
            v.detail
          )}
        </p>
      </div>

      {/* The width-absorber, and the only shape that SHOWS a partition summing.
          Its labels are the lenses below, so the legend and the bar cannot
          disagree: one class per state drives both. */}
      <div className="sbm-meterwrap">
        <div className="sbm-meter" role="img" aria-label={`Of ${nodes.length} workers: ${meterLabel}`}>
          {states
            .filter((r) => r.count > 0)
            .map((r) => (
              <span
                key={r.chip.id}
                className={`sbm-mseg seg-${r.chip.id} ${
                  activeChip && activeChip !== r.chip.id ? 'is-dim' : ''
                }`}
                style={{ flexGrow: r.count }}
              />
            ))}
        </div>
      </div>

      <div className="sbm-facts">
        <Def k="spend-today">
          {(described) => (
            <div
              className="sbm-bfact"
              tabIndex={0}
              aria-label={`Spent today ${usd(spentTodayUSD)} of ${usd(dailyCeilingUSD)}`}
              {...described}
            >
              <span className="k">Spent today</span>
              <span className="v">
                {usd(spentTodayUSD)} <i>of {usd(dailyCeilingUSD)}</i>
              </span>
            </div>
          )}
        </Def>
        {/* The caveat sits against its figure. The shipped strip put this
            sentence in a footnote under the card and caveated "the 64 open
            findings" — a number the section never showed. */}
        <Def
          k="findings-open"
          note={skew ? `${DEFINITIONS['findings-open']} ${skew}` : undefined}
        >
          {(described) => (
            <div
              className="sbm-bfact"
              tabIndex={0}
              aria-label={`Open findings ${totals.open}${
                totals.expired > 0 ? `, ${totals.expired} past their expiry` : ''
              }`}
              {...described}
            >
              <span className="k">Open findings</span>
              <span className="v">
                {totals.open}
                {totals.expired > 0 ? <i>· {totals.expired} past their expiry</i> : null}
              </span>
            </div>
          )}
        </Def>
      </div>

      <div className="sbm-lensbar" ref={bar} role="toolbar" aria-label="Show only" onKeyDown={onKeyDown}>
        {lenses.map((r, i) => {
          const on = activeChip === r.chip.id
          /* The word that separates the partition from the flags. The states
             sum to the total and the facts deliberately overlap them, and the
             old design said so with a 1.17:1 dashed rule under a 2.50:1 label
             — a load-bearing distinction carried by two things nobody can see.
             Here it is the word, the position, and the swatch. */
          const startsFacts = r.chip.rank === 'fact' && lenses[i - 1]?.chip.rank === 'state'
          return (
            <span className="sbm-lensgrp" key={r.chip.id}>
              {startsFacts ? <span className="sbm-lens-sep">also</span> : null}
              <Def k={r.chip.id}>
                {(described) => (
                  <button
                    type="button"
                    className={`sbm-lens rank-${r.chip.rank} ${on ? 'on' : ''}`}
                    /* The number and the label are separate elements with a
                       flex gap between them, which reads as a space and is
                       not one: the accessible name came out "7switched off".
                       Spelled here so what is announced matches what is on
                       screen. */
                    aria-label={`${r.count} ${r.chip.label}`}
                    aria-pressed={on}
                    tabIndex={i === rovingIndex ? 0 : -1}
                    {...described}
                    onFocus={() => setFocusIdx(i)}
                    onClick={() => onChip(on ? null : r.chip.id)}
                  >
                    <span className="mark" aria-hidden>
                      {on ? <Check size={11} /> : null}
                    </span>
                    {r.chip.rank === 'state' ? (
                      <span className={`sw seg-${r.chip.id}`} aria-hidden />
                    ) : null}
                    <span className="n">{r.count}</span>
                    <span className="lab">{r.chip.label}</span>
                  </button>
                )}
              </Def>
            </span>
          )
        })}

        {notes.map((r) => (
          <span key={r.chip.id} className="sbm-note">
            <span className="n">{r.count}</span> {r.chip.label} — {r.chip.zeroNote}
          </span>
        ))}

        <button type="button" className="sbm-explain" onClick={onExplain}>
          <HelpCircle size={12} aria-hidden /> What each number counts
        </button>
      </div>
    </section>
  )
}

/**
 * The band before the first successful read: a shape, and not one number.
 * Measured on prod 2026-08-08 — the strip it replaces asserted three counts
 * about a fleet it had not read, with those zeros as live buttons.
 *
 * `failed` is the state my own Part 6 promised and the first build did not
 * have. When the FIRST read fails there are no last-good figures to keep, and
 * what shipped was this skeleton, `aria-busy="true"`, forever: visually
 * indistinguishable from still-loading, and announced as busy to a screen
 * reader that would wait for a change that is never coming. On a surface whose
 * silence means *all clear*, "we could not look" and "we are still looking"
 * must not be the same pixels — the same rule that put the loading state here
 * in the first place, one step further along.
 */
export function CensusBandSkeleton({ failed = false }: { failed?: boolean }) {
  if (failed) {
    return (
      <section className="sbm-band tone-failed" aria-label="The fleet could not be read">
        <div className="sbm-verdict">
          <p className="sbm-verdict-head">
            <AlertTriangle size={15} aria-hidden />
            <span>The fleet could not be read.</span>
          </p>
          <p className="sbm-verdict-sub">
            Nothing is shown rather than guessed at — this says nothing about whether your
            workers are running. Try again above.
          </p>
        </div>
      </section>
    )
  }
  return (
    <section className="sbm-band is-loading" aria-busy="true" aria-label="Reading the fleet">
      <div className="sbm-verdict">
        <p className="sbm-verdict-head">
          <span className="sbm-skel sk-head" />
        </p>
        <p className="sbm-verdict-sub">
          <span className="sbm-skel sk-sub" />
        </p>
      </div>
      <div className="sbm-meterwrap">
        <div className="sbm-meter sbm-skel" />
      </div>
      <div className="sbm-facts">
        <span className="sbm-skel sk-fact" />
        <span className="sbm-skel sk-fact" />
      </div>
    </section>
  )
}
