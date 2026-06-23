import type { TextareaHTMLAttributes } from 'react'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

/**
 * Multi-line text field. Matches the H10 Input look (bordered, focus ring),
 * fully tokenized — use for paste-style inputs (keyword lists, notes), typically
 * inside a `<Modal>`. Requires `styles/primitives.css`.
 *
 * Exists so modals never hand-roll a raw <textarea> + bespoke CSS (which drifts
 * from the system and risks colliding with app-level classes).
 */
export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={['h10-ds-textarea', className ?? ''].filter(Boolean).join(' ')} {...rest} />
}
