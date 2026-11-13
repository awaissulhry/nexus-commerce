'use client'
import { useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { mergeLabels } from '../lib/labels'
import { TAG_INPUT_LABELS, type TagInputLabels } from './TagInputLabels'

export interface TagInputProps {
  value: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  suggestions?: string[]
  disabled?: boolean
  className?: string
  maxTags?: number
  'aria-label'?: string
  /** B-W2b-F41: the field's words in the person's language; a word left out stays English. */
  labels?: Partial<TagInputLabels>
}

export function TagInput({
  value, onChange, placeholder: placeholderProp, suggestions = [],
  disabled = false, className, maxTags, 'aria-label': ariaLabel, labels,
}: TagInputProps) {
  const words = mergeLabels(TAG_INPUT_LABELS, labels)
  const placeholder = placeholderProp === undefined ? words.add : placeholderProp
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const atMax = maxTags != null && value.length >= maxTags

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (!tag || value.includes(tag) || atMax) return
    onChange([...value, tag])
  }
  const commit = () => { if (input.trim()) { addTag(input); setInput(''); setOpen(false) } }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
    else if (e.key === 'Tab') commit()
    else if (e.key === 'Backspace' && !input && value.length) onChange(value.slice(0, -1))
    else if (e.key === 'Escape') setOpen(false)
  }
  const filtered = suggestions.filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !value.includes(s))

  return (
    <div className={`nds-taginput${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}>
      <div className="nds-taginput-field" onClick={() => inputRef.current?.focus()}>
        {value.map((tag, i) => (
          <span key={tag} className="nds-taginput-chip">
            {tag}
            <button type="button" aria-label={words.remove(tag)}
              onClick={(e) => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)) }}>
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        {!atMax && (
          <input ref={inputRef} type="text" value={input} aria-label={ariaLabel}
            placeholder={value.length === 0 ? placeholder : ''}
            onChange={(e) => { setInput(e.target.value); setOpen(true) }}
            onKeyDown={onKey}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onFocus={() => { if (input || filtered.length) setOpen(true) }} />
        )}
      </div>
      {open && filtered.length > 0 && (
        <ul className="nds-taginput-menu">
          {filtered.map((s) => (
            <li key={s}>
              <button type="button" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { addTag(s); setInput(''); setOpen(false); inputRef.current?.focus() }}>{s}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
