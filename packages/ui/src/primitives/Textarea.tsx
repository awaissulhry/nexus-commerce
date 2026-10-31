'use client'

import { forwardRef, useId, useState, type ChangeEvent, type TextareaHTMLAttributes } from 'react'
import { textareaCount } from './textareaCounter'
import { mergeLabels } from '../lib/labels'
import { TEXTAREA_LABELS, type TextareaLabels } from './TextareaLabels'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /**
   * A character limit, shown as a counter under the field ("312 / 500", Reviews parts 2026-10-26). It COUNTS, it never
   * blocks typing. Over it the counter turns red and says "38 characters too long", and the field is `aria-invalid`
   * (unless the caller sets that itself). The counter is a polite live region and describes the field.
   */
  limit?: number
  /** The counter's words for the count. Default "312 / 500". */
  counterLabel?: (used: number, limit: number) => string
  /** The counter's words in the person's language (B-W2b-04). Default English; `counterLabel` wins over `counter`. */
  labels?: Partial<TextareaLabels>
  /**
   * `rows` sets the field's height (B-W2b-04, a note box of 2 or 3 lines). Default false: the field keeps its 168 px
   * floor whatever `rows` says — what every field had before this prop, so no page changes until it asks.
   */
  honourRows?: boolean
}

/**
 * Multi-line text field. Matches the H10 Input look (bordered, focus ring),
 * fully tokenized — use for paste-style inputs (keyword lists, notes), typically
 * inside a `<Modal>`. Requires `styles/primitives.css`.
 *
 * Exists so modals never hand-roll a raw <textarea> + bespoke CSS (which drifts
 * from the system and risks colliding with app-level classes).
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, limit, counterLabel, labels, honourRows = false, ...rest },
  ref,
) {
  const words = mergeLabels(TEXTAREA_LABELS, labels)
  const counterId = `${useId()}-count`
  // An uncontrolled field with a limit still needs its text to count it.
  const [ownText, setOwnText] = useState(() => (rest.defaultValue == null ? '' : String(rest.defaultValue)))
  const cls = ['nds-textarea', className ?? ''].filter(Boolean).join(' ')
  // The 168 px floor (primitives.css) gives way, so the browser sizes the field from `rows`; the caller's style wins.
  const style = honourRows ? { minHeight: 0, ...rest.style } : rest.style
  if (limit == null) return <textarea ref={ref} className={cls} {...rest} style={style} />

  const controlled = rest.value != null
  const count = textareaCount(controlled ? String(rest.value) : ownText, limit, counterLabel ?? words.counter, words.tooLong)
  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (!controlled) setOwnText(event.target.value)
    rest.onChange?.(event)
  }
  return (
    <span className={`nds-textarea-wrap${count.over > 0 ? ' over' : ''}`}>
      <textarea
        ref={ref}
        className={cls}
        {...rest}
        style={style}
        onChange={onChange}
        aria-describedby={[rest['aria-describedby'], counterId].filter(Boolean).join(' ')}
        aria-invalid={rest['aria-invalid'] ?? (count.over > 0 ? true : undefined)}
      />
      <span id={counterId} className={`nds-textarea-count${count.over > 0 ? ' over' : ''}`} aria-live="polite">{count.text}</span>
    </span>
  )
})
