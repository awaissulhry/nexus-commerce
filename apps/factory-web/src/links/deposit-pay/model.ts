import type { LinkDeposit } from './api'

/** SCR-199 (W1: the bank-transfer part of links.pay) — the deposit page's view model (the view fetches nothing). */
export interface DepositPayViewModel {
  /** The page's state: reading, ready, or why the link opens nothing (the frame's own words). */
  link: 'loading' | 'valid' | 'unavailable' | 'error'
  deposit: LinkDeposit | null
  /** The field just copied (the page says so once). */
  copied: string | null
  /** The site's zone for dates (default Europe/Rome). */
  timeZone?: string
}

export interface DepositPayActions {
  onCopy?: (what: string, text: string) => void
}

/** An IBAN in groups of four, as people read it aloud ("IT60 X054 …"). */
export const groupedIban = (iban: string): string => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()
