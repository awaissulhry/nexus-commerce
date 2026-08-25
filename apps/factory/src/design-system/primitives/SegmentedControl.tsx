'use client'

/**
 * SegmentedControl — a compact single-select toggle on a sunken track, the active
 * segment raised. The space-efficient alternative to a radio group or a row of tabs for
 * 2–4 mutually-exclusive view modes (e.g. List / Board, Live / Official). Accessible
 * `role="radiogroup"` with ArrowLeft/Right roving selection.
 *
 * 🔴 **It imports its own stylesheet.** The docblock used to say "requires
 * `styles/primitives.css`" and leave that to the caller — an instruction four routes silently
 * failed to follow. Measured on prod 2026-08-19: on `/marketing/ads/rules-automation/automations`
 * **0 of the 8,800 loaded CSS rules defined `.nds-seg`**, so the control rendered as
 * run-together plain text ("ActorsLedgerQueueLimits") with no padding and no track. An unstyled
 * component looks like a layout bug, not a missing import, which is why it survived.
 *
 * A component that cannot render correctly on its own is not a shared component. Next dedupes the
 * import, so this costs nothing and cannot regress.
 */
import '../styles/primitives.css'
import { useRef, type ReactNode, type KeyboardEvent } from 'react'
import type { Size } from './size'

export interface SegmentedOption {
  value: string
  label: ReactNode
  icon?: ReactNode
}
export interface SegmentedControlProps {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  size?: Extract<Size, 'sm' | 'md'>
  disabled?: boolean
  className?: string
}

export function SegmentedControl({ options, value, onChange, size = 'md', disabled = false, className }: SegmentedControlProps) {
  const ref = useRef<HTMLDivElement>(null)

  const move = (dir: 1 | -1) => {
    const idx = options.findIndex((o) => o.value === value)
    const next = (idx + dir + options.length) % options.length
    onChange(options[next].value)
    // shift focus to the newly-selected segment so keyboard nav stays on the active option
    requestAnimationFrame(() => {
      ref.current?.querySelectorAll<HTMLButtonElement>('.nds-seg-opt')[next]?.focus()
    })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  }

  const cls = ['nds-seg', size, disabled ? 'disabled' : '', className ?? ''].filter(Boolean).join(' ')

  return (
    <div ref={ref} className={cls} role="radiogroup" onKeyDown={onKeyDown}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={`nds-seg-opt ${active ? 'on' : ''}`}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
          >
            {opt.icon && <span className="nds-seg-icon">{opt.icon}</span>}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
