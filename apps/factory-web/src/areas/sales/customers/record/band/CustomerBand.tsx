'use client'

import { Fragment, useState, type ReactNode } from 'react'
import { ChevronDown, Info } from 'lucide-react'
import { MetricStrip } from '@nexus/ui/components'
import { Button, FilterChip, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { foldOf, metricsOf, type BandChipItem, type BandTile } from './customer-band'
import './customer-band.css'

/**
 * F-CQ-B (band consistency, Owner 2026-11-23; band/plan.md B1–B11) — the customer page's ONE band, drawn by the Work tab and by
 * Quotes & incoming (and free for the Overview): the design system's own parts, as Sales › Orders draws its tiles.
 *
 *   head      optional (Quotes: "Before an order · <customer>" and its New buttons)
 *   groups    the live groups: `MetricStrip size="sm"` filter tiles in a named group; pressed again = everything; a count without
 *             a door is a plain tile; no chevrons, no icons; "waits on us" = the tile's dot + the words in its tip
 *   notes     quiet text and links, then the closed groups APART as quiet `FilterChip`s (after their word), then the ⓘ when the
 *             band has no chips row
 *   status    one line on every room (Quotes: the open door)
 *   chips     optional (Work's "What waits"): `FilterChip`s with their counts; they wrap to a 2nd row before anything is cut
 *
 * Sized by its OWN room (a container query on its root, never the window): below 720 px the groups fold into ONE button that opens
 * the centred window of the groups (the notes are said there); from 1500 px a chips row stands beside the groups. While read: a
 * Skeleton of the strip's height; a failed read: the host's words, said once. No outer card. It fetches nothing.
 */

export interface CustomerBandModel {
  /** The band's name (its region). */
  readonly label: string
  readonly head?: ReactNode
  /** The live groups' name (`role="group"`): tests and screen readers find the doors by it. */
  readonly groupsLabel: string
  readonly groups: readonly BandTile[]
  /** 'ready': the tiles; 'reading': a Skeleton of the strip; 'failed': `failed` in the strip's place, said once. */
  readonly state: 'ready' | 'reading' | 'failed'
  readonly failed?: ReactNode
  /** The closed groups, apart and quiet, after their word ("Closed:"; none for a single one). */
  readonly closed?: { readonly word?: string; readonly groups: readonly BandTile[] }
  /** The notes line's quiet text and links (folded away on a phone: the window says what matters). */
  readonly notes?: ReactNode
  /** One status line, on every room. */
  readonly status?: ReactNode
  /** The chips row: its name (a quiet word from 1040 px) and its facts. */
  readonly chips?: { readonly label: string; readonly items: readonly BandChipItem[] }
  /** The ⓘ: `window` draws one that opens the groups' window (its words); `tip` is the host's own (an InfoTip). */
  readonly info?: { readonly window: string } | { readonly tip: ReactNode }
  /** The phone's ONE button when no group is pressed: everything, with its number. */
  readonly everything: { readonly label: string; readonly value: ReactNode }
  /** The groups' window: its title, the host's lines under the groups; `open` (design cases): open from the start. */
  readonly window: { readonly title: string; readonly notes?: ReactNode; readonly open?: boolean }
}

export interface CustomerBandActions {
  /** A group's door (live or closed): its records — or, pressed while shown, everything again (the host decides). */
  readonly onGroup?: (id: string) => void
}

export function CustomerBand({ model, actions }: { model: CustomerBandModel; actions?: CustomerBandActions }) {
  const [open, setOpen] = useState(!!model.window.open)
  // The closed groups are groups too: drawn only once the groups are read (never a "—" chip beside the failed words).
  const closed = model.state === 'ready' ? (model.closed?.groups ?? []) : []
  const pick = (id: string) => {
    setOpen(false)
    actions?.onGroup?.(id)
  }
  const fold = foldOf([...model.groups, ...closed], model.everything)
  const infoWindow = model.info && 'window' in model.info ? model.info.window : null
  const infoTip = model.info && 'tip' in model.info ? model.info.tip : null
  const info = infoWindow ? (
    <span className="fw-cb-info">
      <Button size="sm" variant="quiet" aria-label={infoWindow} title={infoWindow} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Info size={15} aria-hidden />
      </Button>
    </span>
  ) : infoTip ? (
    <span className="fw-cb-info">{infoTip}</span>
  ) : null
  const chips = model.chips && model.chips.items.length > 0 ? model.chips : null

  const strip =
    model.state === 'ready' ? (
      <>
        <div className="fw-cb-groups" role="group" aria-label={model.groupsLabel}>
          <MetricStrip size="sm" metrics={metricsOf(model.groups, pick)} />
        </div>
        {/* The phone: the groups fold into ONE button — the group shown, else everything — that opens them as a centred list. */}
        <div className="fw-cb-foldbox">
          <Button block wrap size="lg" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <span className="fw-cb-fold-l">{fold.label}</span>
            <span className="fw-cb-fold-n">{fold.value}</span>
            <ChevronDown size={14} aria-hidden />
          </Button>
        </div>
      </>
    ) : model.state === 'failed' ? (
      <p className="fw-cb-failed" role="status">
        {model.failed}
      </p>
    ) : (
      <div className="fw-cb-skel" aria-busy="true">
        <Skeleton height="100%" />
      </div>
    )

  const closedSet =
    closed.length > 0 ? (
      <span className="fw-cb-closed">
        {model.closed?.word && <span className="fw-cb-closed-w">{model.closed.word}</span>}
        {closed.map((group) =>
          group.door ? (
            <FilterChip key={group.id} pressed={group.pressed} count={group.value} title={group.title} onClick={() => pick(group.id)}>
              {group.label}
            </FilterChip>
          ) : (
            <span key={group.id} className="fw-cb-fact">
              {group.label} <span className="fw-cb-fact-n">{group.value}</span>
            </span>
          ),
        )}
      </span>
    ) : null
  const notes = model.notes || closedSet || (info && !chips) ? (
    <div className="fw-cb-notes">
      {model.notes}
      {closedSet}
      {!chips && info}
    </div>
  ) : null

  return (
    <section className={`fw-cb${chips ? ' has-chips' : ''}`} aria-label={model.label}>
      {model.head && <div className="fw-cb-head">{model.head}</div>}
      <div className="fw-cb-body">
        <div className="fw-cb-main">
          {strip}
          {notes}
          {model.status && (
            <div className="fw-cb-status" role="status">
              {model.status}
            </div>
          )}
        </div>
        {chips && (
          <div className="fw-cb-chips" role="group" aria-label={chips.label}>
            <span className="fw-cb-chips-w" aria-hidden="true">
              {chips.label}
            </span>
            {chips.items.map((chip, index) => (
              <Fragment key={chip.id}>
                {chip.rule && index > 0 && <i className="fw-cb-rule" aria-hidden="true" />}
                <Chip chip={chip} />
              </Fragment>
            ))}
            {info}
          </div>
        )}
      </div>
      {open && (
        // ONE window for the ⓘ and the phone's fold: every group with what it holds (each a door), then the host's lines.
        <Modal open onClose={() => setOpen(false)} title={model.window.title} size="sm">
          <div className="fw-cb-win">
            <ul className="fw-cb-win-list">
              {[...model.groups, ...closed].map((group) => {
                const Icon = group.icon
                const body = (
                  <>
                    {Icon && <Icon size={16} aria-hidden />}
                    <span className="fw-cb-win-w">
                      <b>{group.label}</b>
                      {group.note && <span className="fw-cb-win-n">{group.note}</span>}
                    </span>
                    <b className="fw-cb-win-v">{group.value}</b>
                  </>
                )
                return (
                  <li key={group.id}>
                    {group.door ? (
                      <button type="button" className="fw-cb-win-row" aria-pressed={group.pressed} onClick={() => pick(group.id)}>
                        {body}
                      </button>
                    ) : (
                      <span className="fw-cb-win-row is-plain">{body}</span>
                    )}
                  </li>
                )
              })}
            </ul>
            {model.window.notes}
          </div>
        </Modal>
      )}
    </section>
  )
}

/** One fact of the chips row: a toggle, a door that opens a page or a window, a failed read that reads again — or a plain fact. */
function Chip({ chip }: { chip: BandChipItem }) {
  if (!chip.onPress)
    return (
      <span className="fw-cb-fact" title={chip.failed ?? chip.title}>
        {chip.label} <span className="fw-cb-fact-n">{chip.failed ? '!' : chip.count}</span>
      </span>
    )
  if (chip.failed)
    return (
      <FilterChip badge="!" title={chip.failed} aria-label={`${chip.label}: ${chip.failed}`} onClick={chip.onPress}>
        {chip.label}
      </FilterChip>
    )
  return (
    <FilterChip count={chip.count} title={chip.title} {...(chip.pressed !== undefined ? { pressed: chip.pressed } : {})} {...(chip.dialog ? { 'aria-haspopup': 'dialog' as const } : {})} onClick={chip.onPress}>
      {chip.label}
    </FilterChip>
  )
}
