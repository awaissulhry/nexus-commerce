'use client'

/**
 * FloorButton — the floor kit's one button idiom (gaps G2, G5): sized by the page density, so it is 56 px (64 px for
 * the main action) on the floor tier, 44–48 px on comfortable, and the console's 30 px on standard.
 *
 * Why not `Button` with a class: `.nds-btn` holds the console's fixed sizes, and a tier may never change an existing
 * control (`tokens/density.ts`). This reads `--nds-density-*` instead, with the same variant names and the same colour
 * pairs as `Button` (primary, success and danger: inverse text on the strong fill; warning: the warning text on its tint).
 *
 * - Icon + words: a floor action is never an icon alone unless the app gives it `aria-label` (low literacy: the icon
 *   carries the meaning, the words confirm it).
 * - Held, never `disabled`: `heldReason` keeps the button focusable and announced with its reason (`aria-description`),
 *   and a press does nothing — `scripts/check-silent-disabled.mjs`. Show the reason on screen too: a gloved hand gets
 *   no tooltip.
 * - `type="button"` by default, as `Button`.
 */
import { forwardRef, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react'

import './floor.css'

export type FloorButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'quiet'
/** `sm` a small control (`--nds-density-control-h-sm`), `md` a control, `lg` the screen's main action. */
export type FloorButtonSize = 'sm' | 'md' | 'lg'

export interface FloorButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: FloorButtonVariant
  size?: FloorButtonSize
  /** Drawn at the density's icon size, before the words. */
  icon?: ReactNode
  /** Fills its container. */
  block?: boolean
  /** Why this action cannot run now. Set: held (focusable, announced, inert). */
  heldReason?: string | null
}

export const FloorButton = forwardRef<HTMLButtonElement, FloorButtonProps>(function FloorButton(
  { variant = 'secondary', size = 'md', icon, block, heldReason, className, children, onClick, type = 'button', ...rest },
  ref,
) {
  const cls = ['nds-floor-btn', variant, `size-${size}`, block ? 'block' : '', className ?? ''].filter(Boolean).join(' ')
  const held = heldReason
    ? { 'aria-disabled': true as const, 'aria-description': heldReason, onClick: (e: MouseEvent<HTMLButtonElement>) => e.preventDefault() }
    : { onClick }
  return (
    <button ref={ref} type={heldReason ? 'button' : type} className={cls} {...rest} {...held}>
      {icon ? (
        <span className="nds-floor-icon" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children !== undefined && children !== null && children !== false ? <span className="nds-floor-btn-label">{children}</span> : null}
    </button>
  )
})
