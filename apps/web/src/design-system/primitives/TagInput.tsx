'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TagInputProps {
  /** Controlled value: array of tag strings */
  value: string[]
  onChange: (tags: string[]) => void
  /** Placeholder shown inside the input field */
  placeholder?: string
  /** Suggestions shown as you type (free input still allowed) */
  suggestions?: string[]
  /** Disable adding / removing tags */
  disabled?: boolean
  className?: string
  /** Max number of tags; no limit if undefined */
  maxTags?: number
  /** aria-label for the input */
  'aria-label'?: string
}

/**
 * DS TagInput — tag-based free entry with optional suggestion dropdown.
 * Enter / comma / Tab confirms a tag. Backspace removes the last tag.
 * Used for variation-axis values (Sizes, Colours, etc.) in the flat-file
 * Add Listing popover (EFF.2).
 */
export function TagInput({
  value,
  onChange,
  placeholder = 'Add value…',
  suggestions = [],
  disabled = false,
  className,
  maxTags,
  'aria-label': ariaLabel,
}: TagInputProps) {
  const [input, setInput] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const atMax = maxTags != null && value.length >= maxTags

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (!tag || value.includes(tag) || atMax) return
    onChange([...value, tag])
  }

  const removeTag = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
  }

  const commitInput = () => {
    if (input.trim()) {
      addTag(input)
      setInput('')
      setDropdownOpen(false)
    }
  }

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitInput()
    } else if (e.key === 'Tab') {
      commitInput()
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape') {
      setDropdownOpen(false)
    }
  }

  const filtered = suggestions.filter(
    (s) => s.toLowerCase().includes(input.toLowerCase()) && !value.includes(s),
  )

  return (
    <div className={cn('relative', className)}>
      <div
        className={cn(
          'flex flex-wrap gap-1.5 min-h-[36px] px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600',
          'bg-white dark:bg-slate-800 cursor-text',
          'focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500',
          disabled && 'opacity-60 pointer-events-none',
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag, i) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200 text-xs font-medium"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(i) }}
              className="text-blue-500 hover:text-blue-700 dark:hover:text-blue-100 transition-colors"
              aria-label={`Remove ${tag}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {!atMax && (
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setDropdownOpen(true) }}
            onKeyDown={handleKey}
            onBlur={() => { setTimeout(() => setDropdownOpen(false), 150) }}
            onFocus={() => { if (input || filtered.length) setDropdownOpen(true) }}
            placeholder={value.length === 0 ? placeholder : ''}
            className="flex-1 min-w-[80px] bg-transparent outline-none text-xs text-slate-800 dark:text-slate-100 placeholder:text-tertiary"
            aria-label={ariaLabel}
          />
        )}
      </div>

      {dropdownOpen && filtered.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 top-full mt-1 max-h-40 overflow-y-auto rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg py-1">
          {filtered.map((s) => (
            <li key={s}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { addTag(s); setInput(''); setDropdownOpen(false); inputRef.current?.focus() }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
