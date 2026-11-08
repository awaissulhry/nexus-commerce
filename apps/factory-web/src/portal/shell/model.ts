import type { ActionDue } from '@nexus/ui/patterns/ActionList/index'
import { formatDate, formatDateTime, formatTime } from '../../lib/i18n/format'
import type { Locale } from '../../lib/i18n/locales'
import type { EmailFrequency, EmailSettings, PortalBadge, PortalMe, PortalTask } from './api'
import { isPortalKind, PORTAL_KINDS, type PortalKind } from './nav/portal-nav'

/**
 * The portal frame's rules without a screen (B-W2b-173): pure, held by model.vitest.test.ts. The address, the kinds a person
 * reads as, the notices in order, when "Still there?" asks, the task list as the DS ActionList takes it, the rail's badge
 * words, the e-mail settings' draft and what a save sends, and the keys.
 */

// ── the address ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Addresses under /p/ that are pages of their own, never a party (B-W2b-164's sign-in, B-W2b-167's unsubscribe page). */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['signin', 'unsubscribe'])

/** The portal's address of a party: `/p/<party code>`. */
export const portalPrefix = (code: string): string => `/p/${encodeURIComponent(code)}`

/** The address names this session's party: its code (any case, as typed in a mail) or its id. */
export function addressNamesParty(segment: string, party: Pick<PortalMe['party'], 'id' | 'code'>): boolean {
  let typed: string
  try {
    typed = decodeURIComponent(segment)
  } catch {
    return false
  }
  return typed === party.id || typed.toLowerCase() === party.code.toLowerCase()
}

/** A portal address without its `/p/<party>` (`/` for Home). */
export function portalPathOf(pathname: string, prefix: string): string {
  if (pathname === prefix || pathname === `${prefix}/`) return '/'
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname
}

/** Sign in first, then back to the page the person was going to (B-W2b-164 reads `next`; a mailed link keeps its anchor). */
export const signInHref = (next: string | null): string => (next ? `/p/signin?next=${encodeURIComponent(next)}` : '/p/signin')

/** The kinds a person reads the portal as: their own; an office preview has none and reads as every kind of its party. */
export function kindsOf(me: Pick<PortalMe, 'user' | 'party'>): PortalKind[] {
  if (isPortalKind(me.user.partnerKind)) return [me.user.partnerKind]
  const kinds = me.party.kinds.filter(isPortalKind)
  return kinds.length > 0 ? PORTAL_KINDS.filter((kind) => kinds.includes(kind)) : []
}

/** The person's language: theirs when it is one the portal speaks, else Italian. */
export const localeOfPerson = (locale: string): Locale => (locale === 'en' ? 'en' : 'it')

// ── the notices ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** One banner, the most serious first (design portal.frame › notices). `value` is what a dismissal keeps. */
export interface PortalNotice {
  id: 'preview' | 'offline' | 'record' | 'access-ends'
  tone: 'info' | 'warning' | 'danger' | 'neutral'
  /** The words' key and their values (the view translates). */
  key: string
  params?: Readonly<Record<string, string>>
  /** A dismissal is kept for this value only: a new value shows again. Absent: it cannot be dismissed. */
  value?: string
}

const SEVERITY: Record<PortalNotice['tone'], number> = { danger: 0, warning: 1, info: 2, neutral: 3 }
const ORDER: Record<PortalNotice['id'], number> = { offline: 0, preview: 1, 'access-ends': 2, record: 3 }

export interface NoticeFacts {
  /** An office person's preview: their name, the company, the party. */
  preview?: { viewer: string; company: string; party: string } | null
  /** The connection dropped: what is on screen was loaded at this time (written). */
  offlineSince?: string | null
  /** The person's access ends soon (written date). */
  accessEnds?: string | null
  /** The page's record is read-only (its words' key). */
  record?: { key: string; params?: Readonly<Record<string, string>> } | null
}

/** Every notice that holds, most serious first; the frame shows the first one not dismissed. */
export function noticesOf(facts: NoticeFacts): PortalNotice[] {
  const out: PortalNotice[] = []
  if (facts.preview) out.push({ id: 'preview', tone: 'info', key: 'notice.preview', params: { name: facts.preview.viewer, company: facts.preview.company, party: facts.preview.party } })
  if (facts.offlineSince) out.push({ id: 'offline', tone: 'warning', key: 'notice.offline', params: { time: facts.offlineSince } })
  if (facts.accessEnds) out.push({ id: 'access-ends', tone: 'warning', key: 'notice.accessEnds', params: { date: facts.accessEnds }, value: facts.accessEnds })
  if (facts.record) out.push({ id: 'record', tone: 'neutral', key: facts.record.key, ...(facts.record.params ? { params: facts.record.params } : {}) })
  return out.sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone] || ORDER[a.id] - ORDER[b.id])
}

/** The one banner shown: the most serious one not dismissed (a dismissal holds for its value only). */
export function shownNotice(notices: readonly PortalNotice[], dismissed: Readonly<Record<string, string>>): PortalNotice | null {
  return notices.find((notice) => !(notice.value !== undefined && dismissed[notice.id] === notice.value)) ?? null
}

// ── "Still there?" ───────────────────────────────────────────────────────────────────────────────────────────────────
/** The API's idle end: 30 minutes without a request (slid at most once a minute), never past the absolute end. */
export const PORTAL_IDLE_MS = 30 * 60_000
const SLIDE_MS = 60_000
/** The dialog asks this long before the idle sign-out (design pop:stay-signed-in). */
export const STILL_THERE_LEAD_MS = 2 * 60_000

/** The idle end after a request at `at`: the API slides it once a minute, so it is at least `at + 30 min - 1 min`. */
export function idleEndAfterCall(current: number, at: number, absoluteEnd: number): number {
  return Math.min(absoluteEnd, Math.max(current, at + PORTAL_IDLE_MS - SLIDE_MS))
}

/** When the dialog opens: two minutes before the session ends (the idle end, or the absolute end when that is first). */
export const stillThereAt = (idleEnd: number, absoluteEnd: number): number => Math.min(idleEnd, absoluteEnd) - STILL_THERE_LEAD_MS

/** "Stay signed in" can help: the idle end, not the absolute 12 hours, is what ends the session. */
export const staying = (idleEnd: number, absoluteEnd: number): boolean => idleEnd < absoluteEnd - SLIDE_MS

// ── the task list (COL-043) ──────────────────────────────────────────────────────────────────────────────────────────
const DUE_STATE: Record<PortalTask['due'], ActionDue['state']> = { OVERDUE: 'overdue', TODAY: 'today', SOON: 'soon', LATER: 'later', NONE: 'none' }

export interface TaskRow {
  id: string
  kind: string
  title: string
  /** The verb, said in the row. */
  verb: string
  /** The record as the partner reads it. */
  record: string
  /** Who at the company asked (null: the system). */
  askedBy: string | null
  due: ActionDue | null
  /** `inline`: marked done here with Undo; `link`: the record's page at the request. */
  act: 'inline' | 'link'
  href: string
}

export interface TaskGroup {
  /** The kind (`CONFIRM_PO`): its name is `tasks.kind.<KIND>`. */
  kind: string
  rows: TaskRow[]
}

/** The open tasks as the DS ActionList groups them: one group per kind, in the API's order (due first). */
export function taskGroupsOf(tasks: readonly PortalTask[], locale: Locale, prefix: string, timeZone?: string): TaskGroup[] {
  const groups = new Map<string, TaskRow[]>()
  for (const task of tasks) {
    const rows = groups.get(task.kind) ?? []
    rows.push({
      id: task.id,
      kind: task.kind,
      title: task.words[locale],
      verb: task.verb[locale],
      record: task.record.label,
      askedBy: task.askedBy,
      due: task.dueAt && task.due !== 'NONE' ? { at: task.dueAt, state: DUE_STATE[task.due], text: formatDate(task.dueAt, { locale, timeZone }) } : null,
      act: task.canMarkDone ? 'inline' : 'link',
      href: portalLink(task.link, prefix),
    })
    groups.set(task.kind, rows)
  }
  return [...groups.entries()].map(([kind, rows]) => ({ kind, rows }))
}

/** The API's portal links name the party by code (`/p/<code>/open/…`): kept as they are, or put under this prefix. */
export function portalLink(link: string, prefix: string): string {
  if (link.startsWith('/p/')) return link
  return `${prefix}${link.startsWith('/') ? link : `/${link}`}`
}

// ── the rail's badges ────────────────────────────────────────────────────────────────────────────────────────────────
export interface BadgeWords {
  count: number
  /** "2 to confirm", in the person's language. */
  words: string
}

/** The badges by the task list's area; null (not read, or failed): no badge at all, never 0. */
export function badgesOf(badges: readonly PortalBadge[] | null, locale: Locale): Record<string, BadgeWords> | null {
  if (!badges) return null
  const out: Record<string, BadgeWords> = {}
  for (const badge of badges) if (badge.count > 0) out[badge.area] = { count: badge.count, words: badge.words[locale] }
  return out
}

// ── the bell ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** When a notification came: the time today, else the date and time. */
export function whenText(iso: string, now: number, locale: Locale, timeZone?: string): string {
  const day = (value: number | string) => formatDate(value, { locale, timeZone })
  return day(iso) === day(now) ? formatTime(iso, { locale, timeZone }) : formatDateTime(iso, { locale, timeZone })
}

// ── e-mail settings (COL-063) ────────────────────────────────────────────────────────────────────────────────────────
export type EmailDraft = Readonly<Record<string, EmailFrequency>>

/** The draft as read: every topic's frequency. */
export const emailDraftOf = (settings: EmailSettings): EmailDraft => Object.fromEntries(settings.topics.map((topic) => [topic.topic, topic.frequency]))

/** The topics whose frequency the person changed (never a locked one). */
export function emailChanges(settings: EmailSettings, draft: EmailDraft): { topic: string; frequency: EmailFrequency }[] {
  return settings.topics.filter((topic) => !topic.locked && draft[topic.topic] !== undefined && draft[topic.topic] !== topic.frequency).map((topic) => ({ topic: topic.topic, frequency: draft[topic.topic] }))
}

/** Every non-essential topic is off in the draft (the one switch's state). */
export const allNonEssentialOff = (settings: EmailSettings, draft: EmailDraft): boolean => settings.topics.filter((topic) => !topic.locked).every((topic) => (draft[topic.topic] ?? topic.frequency) === 'OFF')

/** The one switch: every non-essential topic off, or back to a daily summary. */
export function withNonEssential(settings: EmailSettings, draft: EmailDraft, off: boolean): EmailDraft {
  const next: Record<string, EmailFrequency> = { ...draft }
  for (const topic of settings.topics) if (!topic.locked) next[topic.topic] = off ? 'OFF' : 'DAILY'
  return next
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A key press inside a field, a pop-up's own field or with a modifier is never the portal's. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null
  if (!element || typeof element.tagName !== 'string') return false
  if (element.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)
}

/** What a portal key does: `/` search, `?` the shortcuts, `g` then a letter goes to an area. */
export type PortalKeyAction = { kind: 'search' } | { kind: 'shortcuts' } | { kind: 'chord' } | { kind: 'go'; href: string } | null

export function portalKeyAction(key: string, chordOpen: boolean, chords: Readonly<Record<string, string>>): PortalKeyAction {
  if (chordOpen) {
    const href = chords[key.toLowerCase()]
    return href ? { kind: 'go', href } : null
  }
  if (key === '/') return { kind: 'search' }
  if (key === '?') return { kind: 'shortcuts' }
  if (key === 'g') return { kind: 'chord' }
  return null
}
