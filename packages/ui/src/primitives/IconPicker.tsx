'use client'

/**
 * A glyph for a tag, chosen from the closed set. Same shape as `ColorSwatchPicker` — a
 * radiogroup, so arrow keys move between the options as they do in every other radio group —
 * and the first option is "no glyph", which is what every tag created before this looked like.
 */
import { TAG_ICONS, TagGlyph } from './icons/tag-icons'

export interface IconPickerProps {
  /** The chosen icon id, or null for the plain dot. */
  value?: string | null
  onChange: (icon: string | null) => void
  /** Tints the options, so the choice is previewed in the colour the tag will actually wear. */
  color?: string | null
  ariaLabel?: string
  disabled?: boolean
  className?: string
}

export function IconPicker({ value, onChange, color, ariaLabel = 'Icon', disabled, className }: IconPickerProps) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`nds-iconpick${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        role="radio"
        aria-checked={!value}
        aria-label="No icon"
        title="No icon"
        disabled={disabled}
        onClick={() => onChange(null)}
        className={`nds-iconpick-opt${!value ? ' on' : ''}`}
      >
        <TagGlyph color={color} />
      </button>
      {TAG_ICONS.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={value === s.id}
          aria-label={s.label}
          title={s.label}
          disabled={disabled}
          onClick={() => onChange(s.id)}
          className={`nds-iconpick-opt${value === s.id ? ' on' : ''}`}
        >
          <TagGlyph icon={s.id} color={color} />
        </button>
      ))}
    </div>
  )
}
