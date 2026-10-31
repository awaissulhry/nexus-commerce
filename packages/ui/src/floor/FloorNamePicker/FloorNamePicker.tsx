'use client'

/**
 * FloorNamePicker — pick your name with no keyboard (B-W2b-28, design part FloorNamePicker): sign in without a badge,
 * forgot-badge clocking, training sign-off.
 *
 *   <FloorNamePicker label="Scegli il tuo nome" people={workers} recentIds={recent} onPick={(id) => openPin(id)}
 *                    locale="it" labels={ds.floorNamePicker} />
 *
 * - Tiles with initials (no photos: the worker record holds none by design), the name and an optional detail line;
 *   the people who worked here lately first, then everyone A–Z (`floorNamePickerModel.ts`).
 * - A letter strip jumps to a letter: the section scrolls into view and its first tile takes the focus. A letter with
 *   no names stays in the strip, held, and says so — the strip never changes shape.
 * - Arrows move between tiles (← → ↑ ↓ by where the tiles are drawn, Home, End); Tab reaches the strip and the tiles.
 * - `heldReason` holds the whole picker (offline: "Name and PIN need the network. Use your badge."): the reason on
 *   screen, every tile held. A person's own `heldReason` holds that tile only.
 * - Sized by the density: tiles at least the main action's height, 8 mm apart on the floor tier.
 */
import { useId, useMemo, useRef, type KeyboardEvent } from 'react'
import { Lock } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { operatorInitials } from '../OperatorChip'
import { FLOOR_NAME_PICKER_LABELS, type FloorNamePickerLabels } from './FloorNamePickerLabels'
import { gridMove, isGridKey, letterStrip, nameGroups, type FloorPerson } from './floorNamePickerModel'
import '../floor.css'
import './floorNamePicker.css'

export interface FloorNamePickerProps {
  /** The question ("Scegli il tuo nome"). */
  label: string
  people: readonly FloorPerson[]
  /** The people who worked on this tablet lately, most recent first. */
  recentIds?: readonly string[]
  onPick: (id: string, person: FloorPerson) => void
  /** Holds the whole picker, with the reason on screen. */
  heldReason?: string | null
  /** The page language, for sorting (default `en`). */
  locale?: string
  /** The level of the group headings (default 3). */
  headingLevel?: 2 | 3 | 4
  labels?: Partial<FloorNamePickerLabels>
  id?: string
}

export function FloorNamePicker({ label, people, recentIds = [], onPick, heldReason, locale = 'en', headingLevel = 3, labels, id }: FloorNamePickerProps) {
  const lw = mergeLabels(FLOOR_NAME_PICKER_LABELS, labels)
  const auto = useId()
  const labelId = `${auto}-label`
  const rootRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => nameGroups(people, recentIds, locale), [people, recentIds, locale])
  const strip = useMemo(() => letterStrip(groups), [groups])
  const H = `h${headingLevel}` as 'h3'
  const sectionId = (letter: string) => `${auto}-letter-${letter.codePointAt(0)}`

  const tiles = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-name-tile]') ?? [])

  const jump = (letter: string) => {
    const section = rootRef.current?.querySelector<HTMLElement>(`[id="${sectionId(letter)}"]`)
    if (!section) return
    section.scrollIntoView({ block: 'start', behavior: 'smooth' })
    section.querySelector<HTMLButtonElement>('[data-name-tile]')?.focus({ preventScroll: true })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !isGridKey(e.key)) return
    const all = tiles()
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    const next = gridMove(all.map((t) => t.getBoundingClientRect()), at, e.key)
    all[next]?.focus()
  }

  const tile = (p: FloorPerson, group: string) => {
    const held = heldReason || p.heldReason || null
    return (
      <li key={`${group}-${p.id}`} className="nds-floor-name-cell">
        <button
          type="button"
          className="nds-floor-name"
          data-name-tile=""
          aria-disabled={held ? true : undefined}
          aria-description={held || undefined}
          onClick={held ? (e) => e.preventDefault() : () => onPick(p.id, p)}
        >
          <span className="nds-floor-name-initials" aria-hidden>
            {p.initials ?? operatorInitials(p.name)}
          </span>
          <span className="nds-floor-name-text">
            <span className="nds-floor-name-name">{p.name}</span>
            {p.detail ? <span className="nds-floor-name-detail">{p.detail}</span> : null}
            {p.heldReason && !heldReason ? (
              <span className="nds-floor-name-held">
                <span className="nds-floor-icon" aria-hidden>
                  <Lock />
                </span>
                {p.heldReason}
              </span>
            ) : null}
          </span>
        </button>
      </li>
    )
  }

  return (
    <div id={id} ref={rootRef} className="nds-floor-names" role="group" aria-labelledby={labelId} data-held={heldReason ? 'true' : undefined}>
      <div id={labelId} className="nds-floor-names-label">
        {label}
      </div>
      {heldReason ? (
        <p className="nds-floor-names-message" role="status">
          <span className="nds-floor-icon" aria-hidden>
            <Lock />
          </span>
          {heldReason}
        </p>
      ) : null}
      {people.length === 0 ? (
        <p className="nds-floor-names-empty">{lw.empty}</p>
      ) : (
        <>
          <nav className="nds-floor-names-strip" aria-label={lw.letters}>
            {strip.map(({ letter, count }) => (
              <button
                key={letter}
                type="button"
                className="nds-floor-names-letter"
                aria-label={count ? lw.jumpTo(letter) : undefined}
                aria-disabled={count ? undefined : true}
                aria-description={count ? undefined : lw.noneFor(letter)}
                onClick={count ? () => jump(letter) : (e) => e.preventDefault()}
              >
                {letter}
              </button>
            ))}
          </nav>
          <div className="nds-floor-names-groups" onKeyDown={onKeyDown}>
            {groups.recent.length ? (
              <section className="nds-floor-names-group" aria-labelledby={`${auto}-recent`}>
                <H id={`${auto}-recent`} className="nds-floor-names-heading">
                  {lw.recent}
                </H>
                <ul className="nds-floor-names-grid">{groups.recent.map((p) => tile(p, 'recent'))}</ul>
              </section>
            ) : null}
            {groups.letters.map((g) => (
              <section key={g.letter} id={sectionId(g.letter)} className="nds-floor-names-group" aria-labelledby={`${sectionId(g.letter)}-h`}>
                <H id={`${sectionId(g.letter)}-h`} className="nds-floor-names-heading">
                  {g.letter}
                </H>
                <ul className="nds-floor-names-grid">{g.people.map((p) => tile(p, g.letter))}</ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
