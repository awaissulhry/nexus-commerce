'use client'

/**
 * OperatorChip — who is signed in on this shared tablet (gap G2, SCR-022). Initials in a filled circle, the name, and
 * an optional second line (station or role). With `onPress` it is a button that opens the operator's menu (sign out,
 * language); without, a plain label.
 *
 * The app passes the accessible name for the button (`label`, e.g. "Maria Rossi — esci o cambia lingua"): the chip
 * adds no words of its own.
 */
import type { ReactNode } from 'react'

import './floor.css'

export interface OperatorChipProps {
  name: string
  /** A second line: station, role or shift. */
  detail?: string
  /** Default: the first letters of the first and last word of `name`. */
  initials?: string
  /** A photo or avatar node, drawn instead of the initials. */
  avatar?: ReactNode
  /** Opens the operator's menu. Set: the chip is a button. */
  onPress?: () => void
  /** The button's accessible name when it is one (default: the name). */
  label?: string
  /** `aria-expanded` of the menu it opens. */
  expanded?: boolean
}

/** "Maria Rossi" → "MR", "Ana" → "AN"; letters, not code units, so accented names and other scripts hold. */
export function operatorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const first = Array.from(words[0])
  if (words.length === 1) return first.slice(0, 2).join('').toLocaleUpperCase()
  return (first[0] + Array.from(words[words.length - 1])[0]).toLocaleUpperCase()
}

export function OperatorChip({ name, detail, initials, avatar, onPress, label, expanded }: OperatorChipProps) {
  const body = (
    <>
      <span className="nds-floor-operator-avatar" aria-hidden>
        {avatar ?? initials ?? operatorInitials(name)}
      </span>
      <span className="nds-floor-operator-text">
        <span className="nds-floor-operator-name">{name}</span>
        {detail ? <span className="nds-floor-operator-detail">{detail}</span> : null}
      </span>
    </>
  )
  if (!onPress) return <span className="nds-floor-operator">{body}</span>
  return (
    <button type="button" className="nds-floor-operator is-pressable" aria-label={label} aria-expanded={expanded} onClick={onPress}>
      {body}
    </button>
  )
}
