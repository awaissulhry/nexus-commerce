'use client'

/**
 * Bid page — a name a narrow cell or column may cut short (2026-10-11, lane FINAL): its whole text shows on hover AND on
 * keyboard focus, in the DS `Tooltip` (a `title` alone shows on hover only).
 *
 * In a grid whose cells take the focus (the Bids table), a keyboard arrival on the cell hands the focus to the name when
 * the name is cut short — the DS SwitchCell rule (a key on the cell puts the focus on its control, which then shows and
 * announces its words). The arrows, Enter and Shift+Enter still reach the grid: they bubble to the cell. A name shown in
 * full takes no focus, so the walk through the table is unchanged.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Tooltip } from '@/design-system/primitives'
import { isCut } from './fullNameModel'
import styles from './fullName.module.css'

export function FullName({ full, cell, className, children, always = false, label }: {
  /** The whole text, as the tooltip says it. */
  full: string
  /** The grid cell it sits in (AG's `eGridCell`), when the grid's cells take the focus. */
  cell?: HTMLElement | null
  className?: string
  /** What shows; default the name itself. */
  children?: ReactNode
  /** Take the focus from the cell even when nothing is cut short: what shows is a mark (a dash) whose words are the tip. */
  always?: boolean
  /** What a screen reader hears for a mark (it is then an image with this name). */
  label?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!cell) return
    const onFocus = (e: FocusEvent) => {
      if (e.target !== cell || !cell.matches(':focus-visible')) return
      const el = ref.current
      if (el && (always || isCut(el))) el.focus()
    }
    cell.addEventListener('focus', onFocus)
    return () => cell.removeEventListener('focus', onFocus)
  }, [cell, always])
  return (
    <Tooltip label={full} portal className={styles.anchor}>
      <span ref={ref} className={className} tabIndex={cell ? -1 : undefined} {...(label ? { role: 'img', 'aria-label': label } : {})}>{children ?? full}</span>
    </Tooltip>
  )
}
