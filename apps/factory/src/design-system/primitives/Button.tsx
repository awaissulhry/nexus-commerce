import { cloneElement, forwardRef, isValidElement } from 'react'
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import type { Tone } from './tone'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'link'
  | 'quiet'
  | 'success'
  | 'warning'
  | 'tonal'
  | 'danger-outline'
export type ButtonSize = 'lg' | 'md' | 'sm' | 'xs'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `secondary` (white + border) is the base look; `primary` = blue fill; `ghost` = blue outline;
   *  `danger` = red fill for irreversible/live-write actions (call sites were hand-rolling
   *  `!bg-red-600` overrides, which drifted apart and beat every token);
   *  `quiet` = borderless until hover, which then reveals the border and fill. It INHERITS its
   *  context's colour rather than declaring one — the class it replaces (`.acr-btn`, 25 sites)
   *  renders red inside an error card and normal text elsewhere, and a fixed colour made those
   *  sites unconvertible. For an inline value-edit trigger, where `link`'s blue reads as
   *  navigation.
   *
   *  Four more, each filed by a session with the contrast already measured, and each RAISING it:
   *    `success`        green fill, white text — 5.02:1 (`.acr-btn.go` was 4.96)
   *    `warning`        amber tint — 5.69:1 (`.bp-btn.warn` was 5.66)
   *    `tonal`          blue tint, dark blue text — 7.41:1 (`.acr-gg-reset` was 6.62)
   *    `danger-outline` white fill, red text and border — 7.36:1 (`.acr-btn.stop` was 6.06)
   *
   *  `danger-outline` is NOT `danger`: an opaque red fill is a different statement, and the
   *  button it replaces is a "Stop everything" that must not read as the destructive one. */
  variant?: ButtonVariant
  size?: ButtonSize
  /**
   * Strip the button box so it can sit INSIDE running text: zero padding, no radius, and
   * `font: inherit` so it takes the sentence's size, weight and line-height.
   *
   * Without it a `link` button in prose is still a 7px-13px box — it opens a visible gap either
   * side of the word and grows the line box. Measured on /marketing/ads-console/automation,
   * which is why that page hand-rolled `.az-link`.
   *
   * Pairs with any variant; `link` is the usual one.
   */
  inline?: boolean
  /**
   * Fills its container and left-aligns its content — a button shaped like a list row.
   *
   * For a full-bleed row that is itself the control: a card footer's "+ 12 more…", a section
   * header that is the disclosure. Three surfaces hand-rolled it because `Button` is
   * `inline-flex` and centred, so the row's hit target only covered the text.
   *
   * A separator between rows belongs to the LIST, not to each button — this sets no border.
   */
  block?: boolean
  /**
   * Hold a secondary action at the SECONDARY text tier instead of inheriting.
   *
   * `quiet` inherits its context's colour on purpose — the 25 `.acr-btn` sites needed that. But
   * inheriting is not always right: inside a container computing `--nds-grey-900`, an inherited
   * `quiet` renders near-black and a muted action is promoted to full emphasis. Raising contrast
   * is not the same as preserving hierarchy, and there was no way to ask for the second.
   *
   * Pins to `--nds-text-2` (5.91:1 on white, 5.46 on the console ground) — quieter than the body
   * it sits in, and still comfortably above AA.
   */
  muted?: boolean
  /**
   * Render the single child element instead of a `<button>`, giving it this Button's classes.
   *
   * For a control that must be a link — `<Button asChild><Link href="…">Refresh</Link></Button>`.
   * Two surfaces had a `Link` and a `<button>` side by side in one row and could only convert
   * half the row, which left the pair visibly mismatched.
   */
  asChild?: boolean
  /**
   * Engaged/selected — the primary fill, matching the ads console's `.on`.
   *
   * Visual ONLY. It does not emit aria, because the correct attribute depends on what the button
   * does: a popover trigger is a disclosure (`aria-expanded`), a mode selector is a toggle
   * (`aria-pressed`). Pass the right one alongside; `ToolbarButton` can emit `aria-pressed`
   * itself only because it is always a toggle.
   */
  active?: boolean
  /**
   * Colour family for the ENGAGED state. Defaults to the primary blue fill.
   *
   * `active` had one look, but "engaged" does not always mean the same thing: an alert channel
   * that is ON is GREEN on this console, and blue would say something else. Only affects the
   * engaged appearance — an unpressed button is unchanged.
   */
  tone?: Exclude<Tone, 'info'>
  /**
   * Defaults to `'button'`, NOT the HTML default of `'submit'`.
   *
   * A design-system button that submits the nearest form unless told otherwise is a footgun: it
   * behaves correctly in isolation and reloads the page the day someone wraps it in a `<form>`.
   * Every call site that genuinely submits says so with `type="submit"`.
   */
  children?: ReactNode
}

/**
 * The canonical button. Matches the H10 action button (.h10-am-btn) spec,
 * tokenized. Requires `styles/primitives.css`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', type = 'button', active, tone, inline, block, muted, asChild, className, children, ...rest },
  ref,
) {
  const cls = ['nds-btn', variant === 'secondary' ? '' : variant, size === 'md' ? '' : size, active ? 'on' : '', active && tone && tone !== 'neutral' ? tone : '', block ? 'block' : '', muted ? 'muted' : '', inline ? 'inline' : '', className ?? '']
    .filter(Boolean)
    .join(' ')
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>
    return cloneElement(child, {
      className: [cls, child.props.className].filter(Boolean).join(' '),
      ...rest,
    })
  }
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {children}
    </button>
  )
})
