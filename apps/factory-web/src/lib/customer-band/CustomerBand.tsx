'use client'

import { Fragment, useState, type ReactNode } from 'react'
import { ChevronDown, Info } from 'lucide-react'
import { MetricStrip } from '@nexus/ui/components'
import { Button, FilterChip, Pill, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../i18n/ds-parts'
import { foldOf, metricsOf, oursOf, type BandChipItem, type BandTile } from './customer-band'
import './customer-band.css'

/**
 * F-CQ-B (band consistency, Owner 2026-11-23; band/plan.md B1–B11) — the customer page's ONE band, drawn by the Work tab and by
 * Quotes & incoming (and free for the Overview): the design system's own parts, as Sales › Orders draws its tiles.
 *
 *   head      optional (Quotes: "Before an order · <customer>" and its New buttons)
 *   groups    the live groups: `MetricStrip size="sm"` filter tiles in a named group; pressed again = everything; a count without
 *             a door is a plain tile; no chevrons, no icons; "waits on us" = the tile's dot + the words in its tip
 *   notes     quiet text and links (a part marked `fw-cb-roomy` only from 1040 px: the window says it below), then the closed
 *             groups APART as quiet `FilterChip`s (after their word), then the ⓘ when the band has no chips row
 *   status    one line on every room (Quotes: the open door) — not a live region (fx2)
 *   chips     optional (Work's "What waits"): `FilterChip`s with their counts; they wrap to a 2nd row before anything is cut
 *   ⓘ         F-CQ-B fx1 (walk B-01, B-06): ONE for both tabs — the design system's icon button that opens the groups' window, glued to
 *             the last item of its row (never a line of its own)
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
  /** F-CQ-B fx1 (walk B-06): the ⓘ's words — the ONE ⓘ of both tabs, which opens the groups' window. */
  readonly info?: string
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
  // F-CQ-B fx1 (walk B-01, B-06): ONE ⓘ for both tabs, the design system's icon-only button (28 px) — it opens the groups' window;
  // drawn while there are groups to show, and always glued to the last item of its row (`glue`).
  const info =
    model.info && model.groups.length + closed.length > 0 ? (
      <span className="fw-cb-info">
        <Button size="sm" variant="quiet" className="icon" aria-label={model.info} title={model.info} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <Info size={15} aria-hidden />
        </Button>
      </span>
    ) : null
  const glue = (last: ReactNode, key?: string) => (
    <span className="fw-cb-tail" key={key}>
      {last}
      {info}
    </span>
  )
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
            {/* F-CQ-B fx1 (walk B-05): the group shown waits on us — said with the warning dot, as its tile's tip says it. */}
            {fold.ours && (
              <Pill tone="warning" dot>
                {fold.ours}
              </Pill>
            )}
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
        {closed.map((group, index) => {
          const drawn = group.door ? (
            <FilterChip key={group.id} pressed={group.pressed} count={group.value} title={group.title} onClick={() => pick(group.id)}>
              {group.label}
            </FilterChip>
          ) : (
            <span key={group.id} className="fw-cb-fact">
              {group.label} <span className="fw-cb-fact-n">{group.value}</span>
            </span>
          )
          // F-CQ-B fx1: without a chips row the ⓘ ends the notes line, glued to the last closed group.
          return !chips && index === closed.length - 1 ? glue(drawn, group.id) : drawn
        })}
      </span>
    ) : null
  const lonelyInfo = !chips && closed.length === 0 ? info : null
  const notes = model.notes || closedSet || lonelyInfo ? (
    <div className="fw-cb-notes">
      {model.notes}
      {closedSet}
      {lonelyInfo}
    </div>
  ) : null

  return (
    <section className={`fw-cb${chips ? ' has-chips' : ''}`} aria-label={model.label}>
      {model.head && <div className="fw-cb-head">{model.head}</div>}
      <div className="fw-cb-body">
        <div className="fw-cb-main">
          {strip}
          {notes}
          {/* F-CQ-B fx2 (re-look B-09): no live region around buttons — the pressed tile (aria-pressed) and the chip say the state. */}
          {model.status && <div className="fw-cb-status">{model.status}</div>}
        </div>
        {chips && (
          <div className="fw-cb-chips" role="group" aria-label={chips.label}>
            <span className="fw-cb-chips-w" aria-hidden="true">
              {chips.label}
            </span>
            {chips.items.map((chip, index) => (
              <Fragment key={chip.id}>
                {chip.rule && index > 0 && <i className="fw-cb-rule" aria-hidden="true" />}
                {/* F-CQ-B fx1 (walk B-01): the ⓘ glued to the last chip — it never wraps alone onto a line of its own. */}
                {index === chips.items.length - 1 ? glue(<Chip chip={chip} />) : <Chip chip={chip} />}
              </Fragment>
            ))}
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
                const ours = oursOf(group)
                const body = (
                  <>
                    {Icon && <Icon size={16} aria-hidden />}
                    <span className="fw-cb-win-w">
                      {/* F-CQ-B fx1 (walk B-05): a group that waits on us says so here too — the warning dot and the tip's words. */}
                      <span className="fw-cb-win-h">
                        <b>{group.label}</b>
                        {ours && (
                          <Pill tone="warning" dot>
                            {ours}
                          </Pill>
                        )}
                      </span>
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
  // A short label for the phone: both drawn, the band's own room shows one (`display: none` hides the other from screen readers
  // too); the chip's name keeps the long words (the customer's name).
  const label = chip.short ? (
    <>
      <span className="fw-cb-chip-long">{chip.label}</span>
      <span className="fw-cb-chip-short">{chip.short}</span>
    </>
  ) : (
    chip.label
  )
  const count = typeof chip.count === 'string' || typeof chip.count === 'number' ? ` ${chip.count}` : ''
  const name = chip.short ? { 'aria-label': `${chip.label}${count}` } : {}
  if (!chip.onPress)
    return (
      <span className="fw-cb-fact" title={chip.failed ?? chip.title} {...name}>
        {label} <span className="fw-cb-fact-n">{chip.failed ? '!' : chip.count}</span>
      </span>
    )
  if (chip.failed)
    return (
      <FilterChip badge="!" title={chip.failed} aria-label={`${chip.label}: ${chip.failed}`} onClick={chip.onPress}>
        {label}
      </FilterChip>
    )
  return (
    <FilterChip count={chip.count} title={chip.title} {...name} {...(chip.pressed !== undefined ? { pressed: chip.pressed } : {})} {...(chip.dialog ? { 'aria-haspopup': 'dialog' as const } : {})} onClick={chip.onPress}>
      {label}
    </FilterChip>
  )
}
