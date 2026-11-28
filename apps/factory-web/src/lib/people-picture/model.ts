/**
 * owb-b5 (w5.4; design plan § 5zb "pictures, no signs": letters · 12 ready-made pictures · 10 colours; Owner decision K: no photo for
 * now, the schema forbids it) — a person's or a team's picture without a screen. Pure. Owner after the base: S3.
 *
 * - The host passes what it read: the name and, for a team, `Team.pictureKind` (LETTERS · ICON), `pictureIcon` (a lucide id in kebab
 *   case) and `pictureColour` (one of the 10 DS grid tones). Nothing is fetched here.
 * - Letters: two of the name — the first letters of its first and last words ("Team Noor" → "TN"); a one-word name gives its first two
 *   ("Noor" → "NO"); a one-letter name that letter; no name "?".
 * - ICON with one of the 12 → that icon; an unknown icon (or none) → the letters, never a hole.
 * - The tone: one of the 10 grid tones; an unknown or missing colour → slate. Never colour alone: the letters or the icon, and the
 *   name in words beside it or as the picture's name for a screen reader.
 */

/** The 12 ready-made pictures, as lucide ids (the design's needle is `shirt`: lucide has no needle, as the department chip). */
export const PICTURE_ICONS = ['factory', 'shirt', 'scissors', 'layers', 'shield', 'ruler', 'flag', 'package', 'briefcase', 'image', 'users', 'truck'] as const
export type PictureIcon = (typeof PICTURE_ICONS)[number]

/** The 10 DS grid tones (`--nds-grid-tone-<tone>-{bg,fg,rule}`): the picture's colours, light and dark from the tokens. */
export const PICTURE_TONES = ['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan'] as const
export type PictureTone = (typeof PICTURE_TONES)[number]

/** `Team.pictureKind` (the schema's enum TeamPictureKind). */
export type PictureKind = 'LETTERS' | 'ICON'

/** What the host passes: who it is and, for a team, its picture columns as read (unknown values are allowed: they fall back). */
export interface PictureSource {
  readonly name: string | null
  /** A person (a round picture) or a team (a rounded square). Absent: a person. */
  readonly who?: 'person' | 'team'
  readonly kind?: PictureKind | string | null
  readonly icon?: string | null
  readonly colour?: string | null
}

/** What the picture draws. */
export interface PictureFace {
  readonly look: 'letters' | 'icon'
  readonly letters: string
  readonly icon: PictureIcon | null
  readonly tone: PictureTone
  readonly who: 'person' | 'team'
  /** The picture's name for a screen reader (the person's or the team's name; "?" without one). */
  readonly name: string
}

const isIcon = (value: string | null | undefined): value is PictureIcon => !!value && (PICTURE_ICONS as readonly string[]).includes(value)
const isTone = (value: string | null | undefined): value is PictureTone => !!value && (PICTURE_TONES as readonly string[]).includes(value)

/** The first letter or digit of a word ("(Noor)" → "N"); empty when it has none. */
const firstOf = (word: string): string => [...word].find((char) => /\p{L}|\p{N}/u.test(char)) ?? ''

/** Two letters of a name: first and last word's first letters; one word → its first two; none → "?". */
export function lettersOf(name: string | null | undefined): string {
  const words = (name ?? '').split(/[\s·—–-]+/).filter((word) => firstOf(word) !== '')
  if (words.length === 0) return '?'
  if (words.length === 1) {
    const chars = [...words[0]!].filter((char) => /\p{L}|\p{N}/u.test(char))
    return chars.slice(0, 2).join('').toLocaleUpperCase()
  }
  return `${firstOf(words[0]!)}${firstOf(words[words.length - 1]!)}`.toLocaleUpperCase()
}

/** The icon of an id, or null for an unknown one (the picture then shows the letters). */
export function iconOf(id: string | null | undefined): PictureIcon | null {
  return isIcon(id) ? id : null
}

/** The tone of a colour; an unknown or missing colour → slate. */
export function toneOf(colour: string | null | undefined): PictureTone {
  return isTone(colour) ? colour : 'slate'
}

/** The picture of a person or a team from what the host read. */
export function pictureOf(source: PictureSource): PictureFace {
  const icon = source.kind === 'ICON' ? iconOf(source.icon) : null
  return {
    look: icon ? 'icon' : 'letters',
    letters: lettersOf(source.name),
    icon,
    tone: toneOf(source.colour),
    who: source.who ?? 'person',
    name: source.name?.trim() || '?',
  }
}
