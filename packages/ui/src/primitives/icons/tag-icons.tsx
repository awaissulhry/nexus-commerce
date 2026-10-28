'use client'

/**
 * The tag glyph set — a closed vocabulary, for the same reason the colour palette is closed.
 *
 * WHY A GLYPH AT ALL. A tag renders as a 9px dot beside its name. Past about eight hues, dots at
 * that size stop being distinguishable for anyone, and WCAG 1.4.1 forbids colour as the ONLY
 * visual carrier of meaning — roughly 1 in 12 men have a colour vision deficiency. A glyph is
 * distinguishable across dozens of values at 13px and is exactly the redundant encoding the
 * criterion asks for. Trello solves the same problem with pattern overlays; a pattern needs a
 * filled pill to sit in, and our chip is a dot plus a name, so an icon is the fit here.
 *
 * WHY CLOSED. Twenty-four silhouettes chosen to be distinct at 13px — no near-pairs (no circle
 * beside circle-dot). An open icon picker earns a vocabulary of forty glyphs nobody can tell
 * apart, which is the same failure as an open colour picker.
 */
import {
  AlertTriangle, Award, Bookmark, Box, Calendar, Camera, Clock, Crown, Flag, Flame, Gem, Gift, Heart, Leaf, Package, Percent, Shield, Shirt, Snowflake, Sparkles, Star, Sun, Truck, Zap,
  type LucideIcon,
} from 'lucide-react'

export interface TagIconSpec {
  /** Stored on `Tag.icon`. Stable — renaming one orphans every tag that chose it. */
  id: string
  label: string
  Icon: LucideIcon
}

export const TAG_ICONS: readonly TagIconSpec[] = [
  { id: 'star', label: 'Star', Icon: Star },
  { id: 'heart', label: 'Heart', Icon: Heart },
  { id: 'flag', label: 'Flag', Icon: Flag },
  { id: 'bookmark', label: 'Bookmark', Icon: Bookmark },
  { id: 'sparkles', label: 'Sparkles', Icon: Sparkles },
  { id: 'zap', label: 'Zap', Icon: Zap },
  { id: 'flame', label: 'Flame', Icon: Flame },
  { id: 'snowflake', label: 'Snowflake', Icon: Snowflake },
  { id: 'sun', label: 'Sun', Icon: Sun },
  { id: 'leaf', label: 'Leaf', Icon: Leaf },
  { id: 'gift', label: 'Gift', Icon: Gift },
  { id: 'package', label: 'Package', Icon: Package },
  { id: 'box', label: 'Box', Icon: Box },
  { id: 'truck', label: 'Truck', Icon: Truck },
  { id: 'shirt', label: 'Shirt', Icon: Shirt },
  { id: 'award', label: 'Award', Icon: Award },
  { id: 'crown', label: 'Crown', Icon: Crown },
  { id: 'gem', label: 'Gem', Icon: Gem },
  { id: 'shield', label: 'Shield', Icon: Shield },
  { id: 'alert', label: 'Alert', Icon: AlertTriangle },
  { id: 'clock', label: 'Clock', Icon: Clock },
  { id: 'calendar', label: 'Calendar', Icon: Calendar },
  { id: 'percent', label: 'Percent', Icon: Percent },
  { id: 'camera', label: 'Camera', Icon: Camera },
] as const

const BY_ID = new Map(TAG_ICONS.map((s) => [s.id, s]))
export const tagIconSpec = (id: string | null | undefined): TagIconSpec | undefined => (id ? BY_ID.get(id) : undefined)

export interface TagGlyphProps {
  /** The tag's stored icon id. Unknown or absent falls back to the dot. */
  icon?: string | null
  color?: string | null
  size?: number
  className?: string
}

/**
 * What a tag shows before its name: its glyph, or the dot every tag had before glyphs existed.
 * ONE renderer, so the grid cell, the tag dialog and any picker cannot drift apart.
 */
export function TagGlyph({ icon, color, size = 13, className }: TagGlyphProps) {
  const spec = tagIconSpec(icon)
  const tint = color ?? 'var(--nds-text-3)'
  if (!spec) {
    return (
      <span
        aria-hidden
        className={['nds-tag-glyph', 'dot', className].filter(Boolean).join(' ')}
        style={{ background: tint, width: Math.round(size * 0.7), height: Math.round(size * 0.7) }}
      />
    )
  }
  const { Icon } = spec
  // `aria-hidden`: the tag's NAME is beside it and already says what this is. Announcing "star"
  // as well would read the tag twice with a word that is not its name.
  return <Icon size={size} aria-hidden className={['nds-tag-glyph', className].filter(Boolean).join(' ')} style={{ color: tint }} />
}
