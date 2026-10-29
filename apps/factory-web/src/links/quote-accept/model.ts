import type { PdfInput } from '@nexus/ui/components/PdfViewer/index'
import type { LinkState } from '../../shell/links/link-state'
import type { LinkQuote } from './api'

/**
 * SCR-099 — the customer's accept link (design links.quote): what the page shows, from the container (QuoteAccept.tsx).
 * The link's own states first (it did not open: used, expired, withdrawn — one answer from the API; the wrong person),
 * then the quote's (open, expired, being revised, replaced, accepted, declined, withdrawn). No internal cost or margin
 * ever: the link answers the customer's document only.
 */

export const DECLINE_REASONS = ['price', 'delivery', 'otherSupplier', 'notNeeded', 'other'] as const
export type DeclineReason = (typeof DECLINE_REASONS)[number]

export interface QuoteAcceptViewModel {
  /** The link itself: `valid` once it opened (then `quote` says the quote's state). */
  link: LinkState
  quote: LinkQuote | null
  /** The PDF of the version (null while it is fetched). */
  pdf: { src: PdfInput | null; problem: boolean }
  answer: 'idle' | 'busy' | 'done'
  /** The server refused the answer (a message key of `quote-link`), shown in the sign block. */
  problem: string | null
  declineOpen: boolean
  /** The customer asked for a new link from this page. */
  newLinkAsked: boolean
  /** The site's zone. */
  timeZone?: string
}

export interface QuoteAcceptActions {
  onAccept?: (input: { name: string; email?: string; noWithdrawal: boolean }) => void
  onDecline?: (open: boolean) => void
  onDeclineSend?: (input: { reason: DeclineReason; note: string; name: string }) => void
  onNewLink?: () => void
  onCopy?: (text: string) => void
}

/** The privacy notice's company, from the address the API gives (`…/privacy/<company id>`). */
export function privacyCompany(url: string): string | null {
  const match = /\/privacy\/([^/?#]+)/.exec(url)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

/** What the page may still do: accept (with what it must ask), decline. */
export function answerOf(quote: LinkQuote | null, action: 'accept' | 'decline') {
  return quote?.answers.find((answer) => answer.action === action) ?? null
}

/** An IBAN in groups of four, as people read and type it. */
export function groupedIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()
}

/** The decline note the API keeps: the reason in the customer's words, then their note. */
export function declineNote(reason: string, note: string): string {
  const trimmed = note.trim()
  return trimmed ? `${reason} — ${trimmed}` : reason
}
