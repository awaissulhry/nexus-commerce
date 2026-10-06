'use client'

import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Plus } from 'lucide-react'
import { InfoTip } from '../primitives/InfoTip'
import { ListboxPanel, type ListboxPanelOption } from '../components/ListboxPanel'
import { useClickAway } from '../components/useClickAway'
import { usePopoverPosition } from '../components/usePopoverPosition'
import { useHorizontalOverflow } from '../components/useHorizontalOverflow'

/*
 * The scope vocabulary and its tone/label table are PES.2's, and there is exactly one of each
 * (`design-system/grid/renderers/readiness.ts`). This bar does not re-declare the states and does
 * not decide that `blocked` is red — it asks. A local `state === 'blocked' ? 'danger' : …` is the
 * invented rule that makes two surfaces disagree about the same family.
 *
 * Imported by its deep path on purpose: the module is pure (it imports nothing), so this costs no
 * bundle, whereas the `design-system/grid` barrel would pull the whole AG engine into a chip row.
 */
import { readinessMeta, SCOPE_READINESS_STATES, type ScopeReadinessState } from '../grid/renderers/readiness'

export type { ScopeReadinessState }

/**
 * How complete a scope is, as far as the SERVER has said.
 *
 * The DS owns the render contract only — a state from the shared vocabulary and a percentage that
 * is allowed to be unknown. What the percentage counts, and which validator produced it, is the
 * caller's business.
 */
export interface ScopeBarReadiness {
  /**
   * 🔴 `null` is NOT zero and is never drawn as `0%`.
   *
   * In a completeness vocabulary `0%` states that everything required is missing, which is a
   * strong and usually false claim about a scope nobody has scored yet. Unknown renders `—`, and
   * `note` is what turns that dash into an answer.
   */
  pct: number | null
  state: ScopeReadinessState
  /** The source's own sentence. Shown on hover; never reworded by the bar. */
  note?: string
  /**
   * A SENTENCE shown instead of the state word and the percentage (Step 4.3 #2, R-53) — for a scope
   * whose own number would mislead, e.g. the Shared product: "See each channel". The dot keeps the
   * `state`'s tone. Omit and the chip renders exactly as before.
   */
  summary?: string
}

/**
 * The worst of several scope states — the first of `SCOPE_READINESS_STATES` (declared in severity
 * order, most attention first) that is present. `absent` ("nothing set up") is not a verdict and is
 * ignored; `null` when no state carries one. One rule, read from the shared table, never restated.
 */
export function worstScopeState(states: readonly ScopeReadinessState[]): ScopeReadinessState | null {
  const present = new Set<ScopeReadinessState>(states.filter((s) => s !== 'absent'))
  return SCOPE_READINESS_STATES.find((s) => present.has(s)) ?? null
}

export interface ScopeBarItem {
  id: string
  label: string
  /** Omit entirely when this scope carries no readiness; `'loading'` while it is being fetched. */
  readiness?: ScopeBarReadiness | 'loading'
  disabled?: boolean
  /**
   * Why it is disabled. Required in practice, not by the type: a disabled control that cannot
   * explain itself is a dead end (reference_disabled_control_cannot_explain). It becomes the
   * chip's tooltip and its `aria-description`.
   */
  disabledReason?: string
}

export interface ScopeBarProps {
  /**
   * Show the readiness PERCENTAGE beside the state word. Default `true`.
   *
   * 🔴 The asymmetry is the point (spec §14.4). When a chip cannot fit both, the STATE survives and
   * the number is dropped — never the reverse. `Amazon · Blocked` still tells an operator which tab
   * to open next; `Amazon 71%` does not, because 71% is one numeral standing for two different
   * verdicts: "warnings, publishable" and "blocked". A bar that drops the word to keep the number
   * has kept the decoration and thrown away the answer.
   */
  showPercent?: boolean
  /**
   * A visible eyebrow before the chips ("SCOPE").
   *
   * When given it is ALSO the group's accessible name, via `aria-labelledby` — so the label a
   * sighted operator reads and the one a screen reader announces are the same string, and cannot
   * drift apart the way a visible label plus a separate `aria-label` eventually does.
   */
  label?: string
  /** Accessible name when there is no visible `label`. A radiogroup with no name is unlabelled. */
  ariaLabel?: string
  items: ScopeBarItem[]
  active: string
  onChange: (id: string) => void
  /** The `[+]` affordance at the end of the chips (adding a listing alias, connecting a channel). */
  onAdd?: () => void
  addLabel?: string
  /**
   * The right-hand controls — market, locale.
   *
   * They are a SLOT, not props, on purpose: the bar must never grow a second control for a fact a
   * chip already states. The chips name the channel; whatever goes here names the coordinate they
   * are read at. Two controls for one fact is what sank the reverted ads scope bar.
   */
  right?: ReactNode
  className?: string
  /**
   * `'chips'` (default) — the radiogroup of chips, unchanged. `'menu'` (Step 4.3 #2, R-51) — ONE 28px
   * trigger showing the active scope exactly as its chip would, and a listbox of every scope that
   * still carries each one's dot, state word and percentage (and a held scope's reason). The states
   * move behind a click; they are never dropped.
   */
  variant?: 'chips' | 'menu'
}

function pctLabel(r: ScopeBarReadiness): string {
  return r.pct == null ? '—' : `${Math.round(r.pct)}%`
}

function chipTitle(item: ScopeBarItem): string | undefined {
  if (item.disabled && item.disabledReason) return item.disabledReason
  const r = item.readiness
  if (!r) return undefined
  if (r === 'loading') return `${item.label} — checking readiness…`
  const meta = readinessMeta(r.state, 'scope')
  // The state word and the percentage are both ON the chip now (§14.4), so the tooltip no longer
  // repeats them — it carries the part that does not fit: the sentence explaining the verdict. The
  // percentage stays in the title regardless of `showPercent`, so a chip that dropped the number
  // for width still has it on hover rather than losing it outright.
  const head = r.summary != null ? `${item.label} — ${r.summary}` : r.pct == null ? `${item.label} — ${meta.label}` : `${item.label} — ${meta.label} · ${pctLabel(r)}`
  // The caller's `note` is the server's own sentence and outranks the generic hint; neither is
  // reworded here.
  return `${head}. ${r.note ?? meta.hint}`
}

/**
 * ScopeBar — choose which LAYER of a record you are editing.
 *
 * A row of chips (a master/base scope plus one per channel), each carrying how complete that scope
 * is, and a slot for the coordinate controls those chips are read at. Built for the Product Edit
 * Studio (PES.1), where the same sheet is re-projected per scope.
 *
 * ⚠ It is not a filter bar. It does not narrow a result set; it changes which stored layer the
 * surface below is showing and writing. The ads console's `*ScopeBar` files answer the other
 * question (market × portfolio × campaign reach) and were merged into `AdsFilterBar` — nothing
 * here is a fork of them, and nothing there should become a fork of this. That page-local bar was
 * re-forked at least three times precisely because it never became one DS component
 * (reference_ra_scope_bar_forked_three_times).
 *
 * Semantics: a `radiogroup`, because this is one choice out of N — not a tablist, which would put a
 * second set of tab semantics beside the surface's real tab strip. Arrow keys move the selection;
 * a roving tabindex keeps the group a single tab stop.
 */
export function ScopeBar({
  label,
  ariaLabel = 'Scope',
  items,
  active,
  onChange,
  onAdd,
  addLabel = 'Add',
  right,
  className,
  showPercent = true,
  variant = 'chips',
}: ScopeBarProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const labelId = useId()

  // Reveal the editing destination after navigation, readiness updates and resize.
  // Move only this track; changing scope must never scroll the surrounding page.
  useLayoutEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLButtonElement>(`[data-scope-id="${CSS.escape(active)}"]`)
    if (!list || !selected) return
    const reveal = () => {
      const track = list.getBoundingClientRect(), chip = selected.getBoundingClientRect()
      if (chip.left < track.left + 3 || chip.width > track.width) list.scrollLeft += chip.left - track.left - 3
      else if (chip.right > track.right - 3) list.scrollLeft += chip.right - track.right + 3
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    observer.observe(selected)
    return () => observer.disconnect()
  }, [active, items])
  // The chips track scrolls sideways: while it does, the bar keeps its scrollbar in a band under the chips
  // (patterns.css), never over a chip or its focus ring.
  useHorizontalOverflow(listRef, { enabled: variant !== 'menu' })

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
      // Held scopes remain reachable so their refusal can be read.
      const usable = items
      if (usable.length < 2) return
      e.preventDefault()
      const focused = (e.target as HTMLElement).closest<HTMLElement>('[data-scope-id]')?.dataset.scopeId ?? active
      const at = usable.findIndex((i) => i.id === focused)
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? usable.length - 1
            : e.key === 'ArrowRight'
              ? (at + 1 + usable.length) % usable.length
              : (at - 1 + usable.length) % usable.length
      const target = usable[next]
      if (!target) return
      if (!target.disabled) onChange(target.id)
      // A held target receives focus without changing the selected scope.
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-scope-id="${CSS.escape(target.id)}"]`)
        ?.focus()
    },
    [items, active, onChange],
  )

  if (variant === 'menu') {
    return (
      <div className={['nds-scopebar', 'is-menu', className ?? ''].filter(Boolean).join(' ')}>
        {label && <span className="nds-scopebar-label" id={labelId}>{label}</span>}
        <ScopeMenu items={items} active={active} onChange={onChange} showPercent={showPercent} labelId={label ? labelId : undefined} ariaLabel={ariaLabel} />
        {right != null && <div className="nds-scopebar-right">{right}</div>}
      </div>
    )
  }

  return (
    <div className={['nds-scopebar', className ?? ''].filter(Boolean).join(' ')}>
      {label && (
        <span className="nds-scopebar-label" id={labelId}>
          {label}
        </span>
      )}
      <div
        className="nds-scopebar-chips"
        role="radiogroup"
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        ref={listRef}
        onKeyDown={onKeyDown}
      >
        {items.map((item) => {
          const on = item.id === active
          const r = item.readiness
          const loading = r === 'loading'
          const ready = r && r !== 'loading' ? r : null
          const tone = ready ? readinessMeta(ready.state, 'scope').tone : null
          const button = (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={on}
              // One Tab stop; arrows also reach held scopes without selecting them.
              tabIndex={on ? 0 : -1}
              data-scope-id={item.id}
              className={['nds-scope', on ? 'on' : ''].filter(Boolean).join(' ')}
              aria-disabled={item.disabled || undefined}
              title={chipTitle(item)}
              aria-description={item.disabled ? item.disabledReason : undefined}
              onClick={() => { if (!item.disabled) onChange(item.id) }}
            >
              {tone && <span className={`nds-scope-dot ${tone}`} aria-hidden />}
              <span className="nds-scope-label">{item.label}</span>
              {/* §14.4 — the STATE word, and it comes before the number. `Master 71%` and
                  `Amazon 71%` showed one numeral for "warnings, publishable" and "blocked"; the
                  word is the half that tells an operator which tab to open next, so it is the half
                  that survives when the chip runs out of room. Not `aria-hidden`: it is the chip's
                  answer, not decoration. */}
              {ready && (
                <>
                  <span className="nds-scope-sep" aria-hidden>·</span>
                  <span className="nds-scope-state">{ready.summary ?? readinessMeta(ready.state, 'scope').label}</span>
                </>
              )}
              {/* Measuring is a SKELETON, never a dash: `—` already means "not scored / not listed",
                  so reusing it would say the answer is nothing when the answer is not in yet
                  (UX.1 §3.6(3)). `aria-busy` is what tells a screen reader the same thing the
                  shimmer tells the eye. */}
              {loading && (
                <span
                  className="nds-scope-pct loading"
                  role="status"
                  aria-busy="true"
                  aria-label={`${item.label} — checking readiness`}
                />
              )}
              {/* Dropped, not shrunk, when width forces the choice — and only ever the number.
                  It stays in `chipTitle` on hover either way, so it is de-prioritised rather than
                  lost.

                  🔴 `absent` renders NO dash (hub #549). For the other three states `—` means
                  "this scope has a verdict but no score", which is a real second fact. For
                  `absent` the state word already IS "nothing has been set up here", so the dash
                  repeats it — `eBay · Not set up —` says the same thing twice, and the second time
                  in a glyph that elsewhere means something else. Reviewed on market DE, where
                  every scope is absent. */}
              {ready && showPercent && ready.summary == null && !((ready.state === 'absent' || ready.state === 'notComputed') && ready.pct == null) && (
                <span className={`nds-scope-pct${ready.pct == null ? ' unknown' : ''}`}>
                  {pctLabel(ready)}
                </span>
              )}
            </button>
          )
          return item.disabled && item.disabledReason
            ? <InfoTip key={item.id} tip={item.disabledReason}>{button}</InfoTip>
            : button
        })}
        {onAdd && (
          <button type="button" className="nds-scope add" onClick={onAdd} title={addLabel} aria-label={addLabel}>
            <Plus size={13} aria-hidden />
          </button>
        )}
      </div>
      {right != null && <div className="nds-scopebar-right">{right}</div>}
    </div>
  )
}

/** Whether a scope shows its percentage — the chip's rule, one definition for chip, trigger and option. */
function showsPct(r: ScopeBarReadiness, showPercent: boolean): boolean {
  return showPercent && r.summary == null && !((r.state === 'absent' || r.state === 'notComputed') && r.pct == null)
}

/** The state text an option trails with: the summary, or the state word and (when shown) the percentage. */
function stateText(r: ScopeBarReadiness, showPercent: boolean): string {
  if (r.summary != null) return r.summary
  const word = readinessMeta(r.state, 'scope').label
  return showsPct(r, showPercent) ? `${word} · ${pctLabel(r)}` : word
}

/**
 * The menu's rows, from the same items the chips render — one per scope, in order. PURE apart from
 * the dot node. A held scope keeps its reason (`heldReason`: reachable, announced, never selected);
 * a loading scope says so rather than showing a dash.
 */
export function scopeMenuOptions(items: readonly ScopeBarItem[], showPercent = true): ListboxPanelOption[] {
  return items.map((item) => {
    const r = item.readiness
    const ready = r && r !== 'loading' ? r : null
    const tone = ready ? readinessMeta(ready.state, 'scope').tone : null
    return {
      value: item.id,
      label: item.label,
      leading: tone ? <span className={`nds-scope-dot ${tone}`} aria-hidden /> : undefined,
      trailing: item.disabled ? 'Unavailable' : r === 'loading' ? 'Checking…' : ready ? stateText(ready, showPercent) : undefined,
      title: chipTitle(item),
      heldReason: item.disabled ? item.disabledReason ?? 'Unavailable' : undefined,
    }
  })
}

function ScopeMenu({ items, active, onChange, showPercent, labelId, ariaLabel }: {
  items: ScopeBarItem[]; active: string; onChange: (id: string) => void; showPercent: boolean; labelId?: string; ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const faceId = useId()
  const { popRef, style } = usePopoverPosition(open, ref, { width: 'anchor' })
  useClickAway([ref, popRef], () => setOpen(false), open)
  const close = () => { setOpen(false); triggerRef.current?.focus() }
  const item = items.find((i) => i.id === active)
  const r = item?.readiness
  const ready = r && r !== 'loading' ? r : null
  const tone = ready ? readinessMeta(ready.state, 'scope').tone : null
  const held = item?.disabled === true
  return (
    <div className="nds-scope-menu" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="nds-scope nds-scope-trigger"
        data-scope-trigger=""
        data-scope-id={active}
        data-scope-held={held ? 'true' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId ? `${labelId} ${faceId}` : undefined}
        aria-label={labelId ? undefined : ariaLabel}
        aria-description={held ? item?.disabledReason : undefined}
        title={item ? chipTitle(item) : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span id={faceId} className="nds-scope-face">
          {tone && <span className={`nds-scope-dot ${tone}`} aria-hidden />}
          <span className="nds-scope-label">{item?.label ?? active}</span>
          {ready && (
            <>
              <span className="nds-scope-sep" aria-hidden>·</span>
              <span className="nds-scope-state">{ready.summary ?? readinessMeta(ready.state, 'scope').label}</span>
            </>
          )}
          {r === 'loading' && <span className="nds-scope-pct loading" role="status" aria-busy="true" aria-label={`${item?.label ?? active} — checking readiness`} />}
          {ready && showsPct(ready, showPercent) && <span className={`nds-scope-pct${ready.pct == null ? ' unknown' : ''}`}>{pctLabel(ready)}</span>}
        </span>
        <ChevronDown size={13} className="chev" aria-hidden />
      </button>
      {open && createPortal(
        <ListboxPanel
          panelRef={popRef}
          style={style}
          className="nds-scope-menu-pop"
          ariaLabel={ariaLabel}
          options={scopeMenuOptions(items, showPercent)}
          value={active}
          onCommit={(id) => { onChange(id); close() }}
          onCancel={close}
        />,
        document.body,
      )}
    </div>
  )
}
