/** CR rebuild 2 — times in the Control Room's words: "12 min ago", "06 Oct, 13:25". */

/** How long ago, or "never". */
export function agoWords(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (Number.isNaN(mins)) return '—'
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

/** A moment, in the viewer's time zone. */
export function whenWords(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
