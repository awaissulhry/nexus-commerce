'use client'

/**
 * SelectableCard — a whole card that is one pressable control (B-W2b-09; B-W2a-38's line card, the design's
 * "SelectableCard"): rich content (a title, a state, lines, a progress bar) and a picked state shown by a frame, a tick
 * mark AND a word — never colour alone.
 *
 *   <SelectableCard title="L1 · Linea giacche" aside={<Tag tone="success">Running</Tag>} selected={scope === 'L1'}
 *     onSelect={() => setScope(scope === 'L1' ? null : 'L1')}>…lines…</SelectableCard>
 *
 *   <SelectableCardGroup label="Lines" mode="single" value={scope} onChange={setScope}
 *     options={lines.map((line) => ({ id: line.id, title: …, children: …, held: line.closed ? 'Closed today' : null }))} />
 *
 * - Alone, a card is a toggle button (`aria-pressed`). In a `single` group it is a radio (one Tab stop, arrows move and
 *   pick); in a `multiple` group each card is a toggle.
 * - `heldReason`: the card stays focusable and says why it cannot be picked (tooltip and `aria-description`), a click
 *   does nothing — never `disabled`.
 * - The content sits inside the control: phrasing content only (spans, `ProgressBar`, `Tag`) — no links or buttons in
 *   it (a control inside a control is not allowed). Put a card's own link beside the group.
 * Its own entry point (`components/SelectableCard`), not in the components barrel.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { CheckCircle2 } from 'lucide-react'

import { Tooltip } from '../../primitives/Tooltip'
import { mergeLabels } from '../../lib/labels'
import { SELECTABLE_CARD_LABELS, type SelectableCardLabels } from './SelectableCardLabels'
import { CARD_MOVE_KEYS, cardMove, cardTabStop, cardToggle, type CardMoveKey } from './selectableCardModel'
import './selectable-card.css'

export interface SelectableCardProps {
  /** The card's first line. Also its name, with `ariaLabel` for the whole sentence. */
  title: ReactNode
  /** Beside the title (a state tag). */
  aside?: ReactNode
  /** The card's other lines. Phrasing content only. */
  children?: ReactNode
  selected: boolean
  onSelect: () => void
  /** Why it cannot be picked now (focusable, says why, inert to a click). */
  heldReason?: string | null
  /** The whole card's name for a screen reader ("L1 Linea giacche, running"). */
  ariaLabel?: string
  /** In a group: the group's role for this card. */
  role?: 'radio'
  tabIndex?: number
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  buttonRef?: (element: HTMLButtonElement | null) => void
  labels?: Partial<SelectableCardLabels>
  className?: string
}

export function SelectableCard({
  title, aside, children, selected, onSelect, heldReason, ariaLabel, role, tabIndex, onKeyDown, buttonRef, labels, className,
}: SelectableCardProps) {
  const words = mergeLabels(SELECTABLE_CARD_LABELS, labels)
  const cls = ['nds-selcard', selected ? 'is-on' : '', heldReason ? 'is-held' : '', className ?? ''].filter(Boolean).join(' ')
  const state = role === 'radio' ? { role: 'radio' as const, 'aria-checked': selected } : { 'aria-pressed': selected }
  const card = (
    <button
      ref={buttonRef}
      type="button"
      className={cls}
      {...state}
      aria-label={ariaLabel}
      aria-disabled={heldReason ? true : undefined}
      aria-description={heldReason ?? undefined}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (heldReason) {
          event.preventDefault()
          return
        }
        onSelect()
      }}
    >
      <span className="nds-selcard-top">
        <span className="nds-selcard-title">{title}</span>
        {aside != null && <span className="nds-selcard-aside">{aside}</span>}
      </span>
      {children != null && <span className="nds-selcard-body">{children}</span>}
      {selected && (
        <span className="nds-selcard-mark">
          <CheckCircle2 size={14} aria-hidden />
          <span>{words.selected}</span>
        </span>
      )}
    </button>
  )
  return heldReason ? <Tooltip label={heldReason} portal>{card}</Tooltip> : card
}

export interface SelectableCardOption {
  id: string
  title: ReactNode
  aside?: ReactNode
  children?: ReactNode
  ariaLabel?: string
  held?: string | null
}

interface GroupBase {
  /** The group's name: "Lines". */
  label: string
  options: readonly SelectableCardOption[]
  /** The cards' minimum width in a row (they wrap). Default 16rem. */
  minCardWidth?: string
  labels?: Partial<SelectableCardLabels>
  className?: string
}

export type SelectableCardGroupProps = GroupBase & (
  /** One card or none: a click on the picked card clears it when `clearable`. */
  | { mode: 'single'; value: string | null; onChange: (id: string | null) => void; clearable?: boolean }
  | { mode: 'multiple'; value: readonly string[]; onChange: (ids: string[]) => void }
)

export function SelectableCardGroup(props: SelectableCardGroupProps) {
  const { label, options, minCardWidth, labels, className } = props
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const style = minCardWidth ? { ['--nds-selcard-min' as string]: minCardWidth } : undefined
  const cls = ['nds-selcard-group', className ?? ''].filter(Boolean).join(' ')
  if (props.mode === 'multiple') {
    const { value, onChange } = props
    return (
      <div className={cls} role="group" aria-label={label} style={style}>
        {options.map((option) => (
          <SelectableCard
            key={option.id}
            title={option.title}
            aside={option.aside}
            ariaLabel={option.ariaLabel}
            heldReason={option.held}
            selected={value.includes(option.id)}
            onSelect={() => onChange(cardToggle(value, option.id, options))}
            labels={labels}
          >
            {option.children}
          </SelectableCard>
        ))}
      </div>
    )
  }
  const { value, onChange, clearable = false } = props
  const stop = cardTabStop(options, value)
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!(CARD_MOVE_KEYS as readonly string[]).includes(event.key)) return
    event.preventDefault()
    const rtl = typeof document !== 'undefined' && document.dir === 'rtl'
    const next = cardMove(options, id, event.key as CardMoveKey, rtl)
    if (!next) return
    onChange(next)
    refs.current.get(next)?.focus()
  }
  return (
    <div className={cls} role="radiogroup" aria-label={label} style={style}>
      {options.map((option) => (
        <SelectableCard
          key={option.id}
          role="radio"
          title={option.title}
          aside={option.aside}
          ariaLabel={option.ariaLabel}
          heldReason={option.held}
          selected={value === option.id}
          tabIndex={option.id === stop ? 0 : -1}
          onKeyDown={(event) => onKey(event, option.id)}
          buttonRef={(element) => {
            if (element) refs.current.set(option.id, element)
            else refs.current.delete(option.id)
          }}
          onSelect={() => onChange(value === option.id ? (clearable ? null : option.id) : option.id)}
          labels={labels}
        >
          {option.children}
        </SelectableCard>
      ))}
    </div>
  )
}
