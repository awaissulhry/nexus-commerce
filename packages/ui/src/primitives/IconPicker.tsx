'use client'

/**
 * A glyph for a tag, chosen from the closed set. Same shape as `ColorSwatchPicker` — a
 * radiogroup, so arrow keys move between the options as they do in every other radio group —
 * and the first option is "no glyph", which is what every tag created before this looked like.
 */
import { TAG_ICONS, TagGlyph } from './icons/tag-icons'
import { labelFor, mergeLabels } from '../lib/labels'
import { ICON_PICKER_LABELS, type IconPickerLabels } from './IconPickerLabels'

export interface IconPickerProps {
  /** The chosen icon id, or null for the plain dot. */
  value?: string | null
  onChange: (icon: string | null) => void
  /** Tints the options, so the choice is previewed in the colour the tag will actually wear. */
  color?: string | null
  ariaLabel?: string
  disabled?: boolean
  className?: string
  /** Its words in the person's language (B-W2b-04): the group's name, "No icon", each icon's name. Default English;
   *  `ariaLabel` wins. */
  labels?: Partial<IconPickerLabels>
}

export function IconPicker({ value, onChange, color, ariaLabel, disabled, className, labels }: IconPickerProps) {
  const words = mergeLabels(ICON_PICKER_LABELS, labels)
  return (
    <div role="radiogroup" aria-label={ariaLabel === undefined ? words.group : ariaLabel} className={`nds-iconpick${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        role="radio"
        aria-checked={!value}
        aria-label={words.none}
        title={words.none}
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
          aria-label={labelFor(words.names, s.id, s.label)}
          title={labelFor(words.names, s.id, s.label)}
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
