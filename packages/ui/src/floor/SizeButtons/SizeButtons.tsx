'use client'

/**
 * SizeButtons — pick the size to count (gap G6, SCR-094, 090): one big button per size with what is still to do in it,
 * the picked size marked, held sizes kept in view with their reason.
 *
 *   <SizeButtons label="Taglia" sizes={[{ id: '50', label: '50', remaining: 4 }, { id: '52', label: '52', remaining: 0 }]}
 *                value={size} onChange={setSize} remainingLabel={(n) => `${n} da tagliare`} doneLabel="Fatto" />
 *
 * - A radio group (`sizeButtonsModel.ts`): one Tab stop; arrows move and pick (wrapping, mirrored right to left);
 *   Home / End; Space or Enter picks the focused size. A held size (`heldReason`) is reached and announced, never picked.
 * - Each button: the size big, under it the count still to do as a number (with `remainingLabel` words for a screen
 *   reader) or, at zero, a tick and `doneLabel`. Picked: a primary border, a thick bar under it and a tinted ground —
 *   never colour alone.
 * - Sized by the density: on the floor tier at least 80 px square with 8 mm between buttons; as many a row as fit, by
 *   the group's own width.
 * - Every word comes from the app.
 */
import { useId, useRef, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'

import { isSizeNavKey, sizeCanPick, sizeKeyTarget, sizePress, sizeState, sizeTabStop, type SizeButton } from './sizeButtonsModel'
import '../floor.css'
import './sizeButtons.css'

export interface SizeButtonsProps {
  /** The group's name ("Taglia"). */
  label: string
  /** Keep the name for screen readers only. */
  hideLabel?: boolean
  sizes: readonly SizeButton[]
  /** The picked size's id, or null. */
  value: string | null
  onChange: (id: string) => void
  /** (4, size) => "4 da tagliare" — the count in words for a screen reader. Default: the number. */
  remainingLabel?: (remaining: number, size: SizeButton) => string
  /** The word under the tick of a size with nothing left ("Fatto"). */
  doneLabel?: string
  id?: string
}

export function SizeButtons({ label, hideLabel, sizes, value, onChange, remainingLabel, doneLabel, id }: SizeButtonsProps) {
  const labelId = useId()
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const stop = sizeTabStop(sizes, value)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !isSizeNavKey(e.key)) return
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-size-id]')?.dataset.sizeId ?? stop
    const dir = getComputedStyle(e.currentTarget).direction === 'rtl' ? 'rtl' : 'ltr'
    const target = sizeKeyTarget(sizes, from, e.key, dir)
    if (target == null) return
    e.preventDefault()
    buttons.current.get(target)?.focus()
    const size = sizes.find((s) => s.id === target)
    if (size && sizeCanPick(size) && target !== value) onChange(target)
  }

  return (
    <div id={id} className="nds-floor-sizes">
      <div id={labelId} className={hideLabel ? 'nds-floor-sr' : 'nds-floor-sizes-label'}>
        {label}
      </div>
      <div className="nds-floor-sizes-grid" role="radiogroup" aria-labelledby={labelId} onKeyDown={onKeyDown}>
        {sizes.map((size) => {
          const state = sizeState(size)
          const picked = size.id === value
          const remaining = size.remaining
          const words = remaining != null ? (remainingLabel?.(remaining, size) ?? String(remaining)) : null
          return (
            <button
              key={size.id}
              ref={(el) => {
                if (el) buttons.current.set(size.id, el)
                else buttons.current.delete(size.id)
              }}
              type="button"
              role="radio"
              className="nds-floor-size"
              data-size-id={size.id}
              data-state={state}
              aria-checked={picked}
              tabIndex={size.id === stop ? 0 : -1}
              aria-disabled={state === 'held' ? true : undefined}
              aria-description={size.heldReason || undefined}
              onClick={() => {
                const next = sizePress(sizes, value, size.id)
                if (next != null && next !== value) onChange(next)
              }}
            >
              <span className="nds-floor-size-label">{size.label}</span>
              {state === 'done' ? (
                <span className="nds-floor-size-done">
                  <span className="nds-floor-icon" aria-hidden>
                    <Check />
                  </span>
                  {doneLabel ? <span>{doneLabel}</span> : null}
                  {!doneLabel && words ? <span className="nds-floor-sr">{words}</span> : null}
                </span>
              ) : remaining != null ? (
                <span className="nds-floor-size-count">
                  <span aria-hidden>{remaining}</span>
                  <span className="nds-floor-sr">{words}</span>
                </span>
              ) : null}
              {size.hint ? <span className="nds-floor-size-hint">{size.hint}</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
