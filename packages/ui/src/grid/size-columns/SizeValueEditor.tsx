'use client'

/**
 * SizeColumns' cell editor (B-W2b-207): a text field with a decimal keypad, opened on the value as the person types it in
 * their language ("62,5" on an Italian page, never "62.5" or "— missing"), or on the digit, separator or minus that
 * opened the cell. It reports the TEXT with `onValueChange` on every change (AG36 React: a ref `getValue` is never read);
 * the column parses it (AG36 does not run `valueParser` on a custom editor's value: `sizeColumns`' `valueSetter` does, by the
 * same rule) into a decimal or refuses it (the value is kept). Enter, Tab and Esc are AG's.
 * Not `type="number"`: a number field clears "." and "-" and refuses the decimal comma.
 */
import { forwardRef, useEffect, useRef, useState } from 'react'

import { sizeEditText } from './sizeColumnsModel'

export interface SizeValueEditorParams {
  value?: unknown
  eventKey?: string | null
  onValueChange?: (value: unknown) => void
  /** The page's language (the decimal separator). */
  locale?: string
  /** The field's name for assistive technology ("Chest width, size M"). */
  label?: string
}

const START = /^[\d.,\-−]$/

export const SizeValueEditor = forwardRef<unknown, SizeValueEditorParams>(function SizeValueEditor(props, _ref) {
  const { value, eventKey, onValueChange, locale = 'en-GB', label } = props
  const typed = eventKey && eventKey.length === 1 && START.test(eventKey) ? eventKey : ''
  const [text, setText] = useState(() => typed || sizeEditText(value as string | number | null | undefined, locale))
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    if (typed) {
      el.setSelectionRange(el.value.length, el.value.length)
      onValueChange?.(typed)
    } else el.select()
    // mount only: the key that opened the cell is taken once, as if typed into the field
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <input
      ref={input}
      className="nds-sizecol-editor"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        onValueChange?.(event.target.value)
      }}
    />
  )
})
