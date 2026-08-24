import { useState } from 'react'
import { TagInput } from '@nexus/design-system'



const SUGGESTIONS = ['gebraucht', 'kinder', 'fahrrad', 'replica', 'sticker', 'visier ersatz']

/** Committed values render as removable chips. Enter or comma commits; Backspace drops the last. */
export const NegativeKeywords = () => {
  const [tags, setTags] = useState(['gebraucht', 'kinder', 'fahrradhelm', 'replica'])
  return (
    <TagInput
      value={tags}
      onChange={setTags}
      suggestions={SUGGESTIONS}
      placeholder="Add a negative keyword… (Enter or comma)"
      aria-label="Negative keywords"
    />
  )
}

/** Empty — the placeholder shows only while there are no chips. */
export const Empty = () => {
  const [tags, setTags] = useState<string[]>([])
  return (
    <TagInput
      value={tags}
      onChange={setTags}
      suggestions={['Black', 'Matte Black', 'Titanium', 'White']}
      placeholder="Add colour values… (Enter or comma)"
      aria-label="Colour axis values"
    />
  )
}

/** `maxTags` retires the text input once the cap is hit; `disabled` fades the whole field. */
export const CappedAndDisabled = () => {
  const [tags, setTags] = useState(['B0CJ4K2QMB', 'B0CJ4K7LP2', 'B0D19XZR4T'])
  const caption = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 440 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={caption}>Targeted ASINs — at the 3 ASIN cap</span>
        <TagInput value={tags} onChange={setTags} maxTags={3} aria-label="Targeted ASINs" />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={caption}>Brand terms — locked by the portfolio</span>
        <TagInput value={['xavier', 'xavier helmets']} onChange={() => {}} disabled aria-label="Brand terms" />
      </label>
    </div>
  )
}
