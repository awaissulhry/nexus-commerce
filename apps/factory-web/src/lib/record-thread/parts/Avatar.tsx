import './parts.css'

/**
 * B-TH-298 — Avatar, built in the factory web first (threads plan §2 DS gate 1; the Owner's yes on decision 2, 2026-11-17: the 8
 * new parts live here until he says they move into packages/ui, B-TH-294). Two shapes, as the design kit draws them (§3): a
 * person is a round tile of initials; an organisation (the customer's side of a thread) is a rounded square in the primary
 * colour. It is decorative: the name always stands in words beside it, so the tile is hidden from screen readers.
 */
export interface AvatarProps {
  /** The person's or organisation's name; null when the reader may not see who (a floor worker behind the site's gate). */
  name: string | null
  kind?: 'person' | 'organisation'
  size?: 'sm' | 'md'
}

/** Company forms left out of an organisation's initials ("Brand Alpha S.r.l." → "BA"). */
const LEGAL_FORMS = /^(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|gmbh|ag|ltd\.?|inc\.?|llc|sa|bv|nv)$/i

/** Up to two initials of a name, from its first and last words ("Dora Campione" → "DC", "Brand Alpha" → "BA"); "?" with none. */
export function initialsOf(name: string | null): string {
  const words = (name ?? '')
    .split(/\s+/)
    .filter((word) => word !== '' && !LEGAL_FORMS.test(word))
    .map((word) => [...word].find((char) => /\p{L}|\p{N}/u.test(char)) ?? '')
    .filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]
  const last = words.length > 1 ? words[words.length - 1] : ''
  return `${first}${last}`.toLocaleUpperCase()
}

export function Avatar({ name, kind = 'person', size = 'md' }: AvatarProps) {
  return (
    <span className={`fw-rt-av${kind === 'organisation' ? ' is-org' : ''}${size === 'sm' ? ' is-sm' : ''}`} aria-hidden="true">
      {initialsOf(name)}
    </span>
  )
}
