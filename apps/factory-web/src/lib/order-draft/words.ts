'use client'

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'
import { DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatTime } from '../i18n/format'
import type { Locale } from '../i18n/locales'
import { useLocale, useT } from '../i18n/provider'
import { pieces } from './model'

/**
 * The words of the ONE draft order (THE SIMPLE ORDER START, od-w1.1): the part's own catalogue `messages/<locale>/order-draft.json`
 * (moved out of `portal-ordering`: one key, one place) and its writers of days, times and pieces (Europe/Rome). No price writer: the
 * shared part never draws money (it lives only in the hosts' own cards). Each host says which door it is (`DraftDoorProvider`): the
 * office reads its own voice for the keys that have one (`office.<key>`: "What the customer needs", IT "tu"), the portal the
 * customer's (IT "voi"). A host page lists `DRAFT_NS` among its `WithMessages` namespaces.
 */

export const DRAFT_NS = 'order-draft'

/** Which door draws the part: it picks a whole word set, never a look. */
export type DraftDoor = 'portal' | 'office'

/**
 * The keys the office says in its own voice (`order-draft` `office.<key>`: "The customer's message", IT "tu"; 10-design-r1 § 6's office
 * voice). Any other key reads the same words in both doors.
 */
export const OFFICE_VOICE: ReadonlySet<string> = new Set([
  'cell.productPh',
  'cf.quoteNext',
  'date.ref',
  'draftPage.measure.LATER', // od-fx8 W-22: "They send the measures later."
  'draftPage.roster.privacy', // od-fx10 W-31: "the customer's riders and team"
  'head.savedByCustomer', // od-fx8 W-09: the office only (a customer's person, with the customer)
  // od-fx2: a reordered row's origin, in the office's voice (the customer's order)
  'lines.fromDay',
  'lines.fromDayRef',
  'lines.fromOwn',
  'lines.fromOwnRef',
  'mail.attHint',
  'mail.drop',
  'mail.message',
  'mail.nothing',
  'opt.alwaysOpen',
  'opt.namesOnly',
  'opt.needChoices',
  'opt.needTopic',
  'save.notYet',
  'save.readonly',
  'siz.peopleFirst',
  'start.continue',
  'still.info',
])

export interface DraftWords {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly locale: Locale
  readonly door: DraftDoor
  /** A calendar day (`YYYY-MM-DD`) or an instant's day, in the page's language. */
  readonly day: (iso: string) => string
  readonly at: (iso: string) => string
  readonly time: (iso: string) => string
  readonly pieces: (n: number) => string
}

/** A calendar day (`YYYY-MM-DD`, read at noon UTC) or an instant's day in the site's zone, in the page's language. */
export const dayWriter = (locale: Locale) => (iso: string) => (iso.length === 10 ? formatDate(`${iso}T12:00:00Z`, { locale, timeZone: 'UTC' }) : formatDate(iso, { locale, timeZone: DEFAULT_TIME_ZONE }))

/** The words of one door: a key with an office voice reads `office.<key>` in the office. */
export function draftWordsFor(own: DraftWords['t'], locale: Locale, door: DraftDoor): DraftWords {
  const t: DraftWords['t'] = (key, params) => own(door === 'office' && OFFICE_VOICE.has(key) ? `office.${key}` : key, params)
  return {
    t,
    locale,
    door,
    day: dayWriter(locale),
    at: (iso) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    time: (iso) => formatTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE }),
    pieces: (n) => pieces(n, locale),
  }
}

const DoorContext = createContext<DraftDoor>('portal')

/** The door the part's views speak for (the start box and the draft page set it from their `kind`). */
export function DraftDoorProvider({ door, children }: { door: DraftDoor; children?: ReactNode }) {
  return createElement(DoorContext.Provider, { value: door }, children)
}

export function useDraftWords(): DraftWords {
  const own = useT(DRAFT_NS)
  const locale = useLocale()
  const door = useContext(DoorContext)
  return useMemo(() => draftWordsFor(own, locale, door), [own, locale, door])
}
