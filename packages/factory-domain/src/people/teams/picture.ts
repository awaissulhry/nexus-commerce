/**
 * owb-ss5 (order workflow build, S3; design order-workflow-2026-11-25 § 5zb "pictures, no signs"; Owner decision K: no photo) — the
 * picture of a team or a person as the API sends it: its letters, or one of the 12 icons, on one of the 10 grid tones. Pure. The web
 * draws it (apps/factory-web lib/people-picture, the same lists and the same letters); this side only says what to draw.
 *
 * - A team: `Team.pictureKind` (LETTERS · ICON), `pictureIcon` (a lucide id in kebab case), `pictureColour` (a grid tone). An ICON
 *   picture with an unknown icon is sent as LETTERS (never a hole); an unknown colour as null (the web's slate).
 * - A person: letters only (no picture columns on a person; never a photo).
 * - Letters: the first letters of the first and last words ("Team Noor" → "TN"); one word → its first two ("Noor" → "NO"); none → "?".
 */

/** The 12 icons a team may wear (lucide ids). */
export const PICTURE_ICONS = ['factory', 'shirt', 'scissors', 'layers', 'shield', 'ruler', 'flag', 'package', 'briefcase', 'image', 'users', 'truck'] as const
export type PictureIcon = (typeof PICTURE_ICONS)[number]

/** The 10 grid tones. */
export const PICTURE_TONES = ['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan'] as const
export type PictureTone = (typeof PICTURE_TONES)[number]

export const PICTURE_KINDS = ['LETTERS', 'ICON'] as const
export type PictureKind = (typeof PICTURE_KINDS)[number]

export interface Picture {
  readonly kind: PictureKind
  readonly icon: string | null
  readonly colour: string | null
  readonly letters: string
}

export const isPictureIcon = (value: string | null | undefined): value is PictureIcon => !!value && (PICTURE_ICONS as readonly string[]).includes(value)
export const isPictureTone = (value: string | null | undefined): value is PictureTone => !!value && (PICTURE_TONES as readonly string[]).includes(value)

/** The first letter or digit of a word ("(Noor)" → "N"); empty when it has none. */
const firstOf = (word: string): string => [...word].find((char) => /\p{L}|\p{N}/u.test(char)) ?? ''

/** Two letters of a name: the first and last words' first letters; one word → its first two; none → "?". */
export function lettersOf(name: string | null | undefined): string {
  const words = (name ?? '').split(/[\s·—–-]+/).filter((word) => firstOf(word) !== '')
  if (words.length === 0) return '?'
  if (words.length === 1) return [...words[0]!].filter((char) => /\p{L}|\p{N}/u.test(char)).slice(0, 2).join('').toLocaleUpperCase()
  return `${firstOf(words[0]!)}${firstOf(words[words.length - 1]!)}`.toLocaleUpperCase()
}

/** A team's picture from its row. */
export function teamPicture(team: { readonly name: string; readonly pictureKind: string; readonly pictureIcon: string | null; readonly pictureColour: string | null }): Picture {
  const icon = team.pictureKind === 'ICON' && isPictureIcon(team.pictureIcon) ? team.pictureIcon : null
  return { kind: icon ? 'ICON' : 'LETTERS', icon, colour: isPictureTone(team.pictureColour) ? team.pictureColour : null, letters: lettersOf(team.name) }
}

/** A person's picture: their letters (no icon, no tone of their own). */
export function personPicture(name: string | null | undefined): Picture {
  return { kind: 'LETTERS', icon: null, colour: null, letters: lettersOf(name) }
}
