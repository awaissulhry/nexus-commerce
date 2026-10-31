'use client'

import { useRef, type KeyboardEvent } from 'react'
import { Button } from '@nexus/ui/primitives'
import { iconOf, SYMPTOM_ICON_IDS } from '../../../../lib/plant/symptom-icons'

/**
 * The icon of a symptom, picked from the plant's own icon set (lib/plant/symptom-icons: the ids factory-domain's starter
 * stores and the floor's tiles draw) plus "No icon". Composed here because the DS `IconPicker` offers only its closed TAG
 * glyph set, which holds none of the plant's ids (MISSING DS PART: an IconPicker that takes an app's icon set). Built like
 * the DS pickers: one radio group, one Tab stop (the chosen icon), arrows move and pick, Home / End; every option has its
 * words as its name and its tooltip (never the icon alone). DS Buttons only.
 */
export function SymptomIconPicker({ value, onChange, label, words, disabled }: { value: string | null; onChange: (icon: string | null) => void; label: string; words: (id: string | null) => string; disabled?: boolean }) {
  const options: (string | null)[] = [null, ...SYMPTOM_ICON_IDS]
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const current = Math.max(0, options.indexOf(value))
  const pick = (index: number) => {
    const next = (index + options.length) % options.length
    onChange(options[next] ?? null)
    refs.current[next]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
    if (to === null) return
    event.preventDefault()
    pick(to)
  }
  return (
    <div role="radiogroup" aria-label={label} className="fw-pls-icons">
      {options.map((id, index) => {
        const Icon = iconOf(id)
        const on = index === current
        return (
          <Button
            key={id ?? 'none'}
            ref={(element: HTMLButtonElement | null) => {
              refs.current[index] = element
            }}
            size="sm"
            variant={on ? 'tonal' : 'quiet'}
            role="radio"
            aria-checked={on}
            aria-label={words(id)}
            title={words(id)}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            className="fw-pls-icon"
            onClick={() => onChange(id)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => onKeyDown(event, index)}
          >
            <Icon size={18} aria-hidden />
          </Button>
        )
      })}
    </div>
  )
}
