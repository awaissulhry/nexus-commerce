import type { PortalBand } from '../../shell/frame'

/**
 * The frame's band of the accountant's room (design portal.guest.accountant h: Pill "Read-only", "Access ends 31 Jan 2027",
 * "Download period (zip)" the primary; ⋯ "Ask finance" is the frame's "Ask a question" about the firm's account, which
 * focuses the docked conversation's box — B-TH-276: the portal record frame opens it full width first below 1280 px). One
 * builder for the live page and its design cases.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function accountantBandOf(input: {
  t: Translate
  /** The last day of access, written ("31 gen 2027"); null for an office preview or while unread. */
  until: string | null
  /** The firm's party: what "Ask a question" asks about (null while unread). */
  firmId: string | null
  /** Why "Download period (zip)" waits (words), or null. */
  zipHeld: string | null
  onZip: () => void
}): PortalBand {
  const { t } = input
  return {
    title: t('title'),
    status: { label: input.until ? t('band.status', { date: input.until }) : t('readOnly'), tone: 'info' },
    actions: [{ id: 'zip', label: t('band.zip'), variant: 'primary', heldReason: input.zipHeld, onClick: input.onZip }],
    more: [],
    ask: input.firmId ? { type: 'Party', id: input.firmId, label: t('ask.title') } : null,
    keys: [
      { keys: ['↵'], words: t('keys.download') },
      { keys: ['x'], words: t('keys.select') },
    ],
  }
}
