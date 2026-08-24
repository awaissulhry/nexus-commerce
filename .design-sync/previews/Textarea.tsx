import { useState } from 'react'
import { Textarea } from '@nexus/design-system'

const KEYWORDS = ['motorradhelm integral', 'helm mit bluetooth', 'jethelm damen', 'klapphelm ece 22.06', 'motorradhelm schwarz matt'].join('\n')

/** The paste-style input this primitive exists for: one keyword per line, inside a modal step. */
export const KeywordPaste = () => {
  const [text, setText] = useState(KEYWORDS)
  return (
    <Textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      placeholder="Enter one keyword per line"
      aria-label="Keywords to add"
      spellCheck={false}
    />
  )
}

/** Label above, live counter below — the same wrapper idiom the Input fields use. */
export const LabelledWithCounter = () => {
  const [text, setText] = useState(
    'Full-face ECE 22.06 helmet with a drop-down sun visor, Pinlock-ready shield and a removable, washable liner. Ships from our DE warehouse.',
  )
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Listing description</span>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Listing description" />
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{text.length} / 2000 characters — Amazon truncates after 2000.</span>
    </label>
  )
}

/** `disabled` shades the field to `--surface-sunken` while the text stays readable. */
export const Disabled = () => (
  <Textarea
    value={'B0CJ4K2QMB\nB0CJ4K7LP2\nB0D19XZR4T'}
    disabled
    readOnly
    aria-label="ASINs from the linked portfolio"
  />
)
