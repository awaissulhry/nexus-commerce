/** Presence is its own vocabulary. No conversion to either readiness axis is defined here. */
import type { Tone } from '../../primitives/tone'

export type PresenceIntent = 'NONE' | 'DRAFT' | 'LIVE' | 'HELD' | 'WITHDRAWN' | 'ENDED' | 'DISCONTINUED' | 'RELEASED'
export type ChannelFact = 'UNKNOWN' | 'SELLING' | 'NOT_SELLING' | 'SUPPRESSED' | 'ABSENT' | 'REFUSED'
export type PresenceVerdict = 'agrees' | 'pending' | 'diverged' | 'unknown' | 'unreachable'
export interface PresenceMeta { label: string; tone: Tone; sentence: string }

const INTENT: Record<PresenceIntent, PresenceMeta> = {
  NONE: { label: 'No listing here', tone: 'neutral', sentence: 'We hold no listing record for this coordinate. Nothing has been checked against the channel.' },
  DRAFT: { label: 'Draft', tone: 'neutral', sentence: 'A record exists, never sent.' },
  LIVE: { label: 'Listed', tone: 'info', sentence: 'Our record holds a channel reference.' },
  HELD: { label: 'Held', tone: 'warning', sentence: 'We send nothing; the channel keeps what it has.' },
  WITHDRAWN: { label: 'Offer withdrawn', tone: 'warning', sentence: 'Offer off; listing, identity and reviews stand.' },
  ENDED: { label: 'Ended', tone: 'neutral', sentence: 'Ended on the channel; identity retired.' },
  DISCONTINUED: { label: 'Discontinued', tone: 'danger', sentence: 'Ended, and never recreate.' },
  RELEASED: { label: 'Released', tone: 'neutral', sentence: 'Identity deliberately surrendered.' },
}
const FACT: Record<ChannelFact, PresenceMeta> = {
  UNKNOWN: { label: 'Not checked', tone: 'neutral', sentence: 'Nobody has asked the channel.' },
  SELLING: { label: 'Selling', tone: 'success', sentence: 'The channel confirmed it is selling.' },
  NOT_SELLING: { label: 'Not selling', tone: 'neutral', sentence: 'The channel confirmed it is not buyable.' },
  SUPPRESSED: { label: 'Suppressed', tone: 'danger', sentence: 'The channel is hiding it — their decision.' },
  ABSENT: { label: 'Gone from the channel', tone: 'neutral', sentence: 'The channel answered and has no such listing.' },
  REFUSED: { label: 'Could not ask', tone: 'warning', sentence: 'We asked and could not get an answer.' },
}
const VERDICT: Record<PresenceVerdict, PresenceMeta> = {
  agrees: { label: 'Agrees', tone: 'success', sentence: 'The channel observation agrees with the stated intent.' },
  pending: { label: 'Pending', tone: 'info', sentence: 'A check or change is still in flight.' },
  diverged: { label: 'Diverged', tone: 'danger', sentence: 'The channel observation differs from the stated intent.' },
  unknown: { label: 'Unknown', tone: 'neutral', sentence: 'There is no current channel observation for this intent.' },
  unreachable: { label: 'Could not ask', tone: 'warning', sentence: 'We asked and could not get an answer.' },
}

function meta(table: Record<string, PresenceMeta>, state: string): PresenceMeta {
  return Object.prototype.hasOwnProperty.call(table, state) ? table[state] : { label: state, tone: 'neutral', sentence: `Unrecognised presence state “${state}”.` }
}
export const intentMeta = (intent: PresenceIntent): PresenceMeta => meta(INTENT, intent)
export const factMeta = (fact: ChannelFact): PresenceMeta => meta(FACT, fact)
export const verdictMeta = (verdict: PresenceVerdict): PresenceMeta => meta(VERDICT, verdict)
export const PRESENCE_INTENTS = Object.keys(INTENT) as PresenceIntent[]
export const CHANNEL_FACTS = Object.keys(FACT) as ChannelFact[]
export const PRESENCE_VERDICTS = Object.keys(VERDICT) as PresenceVerdict[]

export interface Presence {
  intent: PresenceIntent
  intentAt: string | null
  fact: ChannelFact
  observedAt: string | null
  inFlight: boolean
  /** The read owns the freshness window; the renderer must not invent a timeout. */
  now: number
  freshnessMs: number
}

export function presenceVerdict(p: Presence): PresenceVerdict {
  if (!Object.prototype.hasOwnProperty.call(INTENT, p.intent) || !Object.prototype.hasOwnProperty.call(FACT, p.fact)) return 'unknown'
  if (p.fact === 'REFUSED') return 'unreachable'
  if (p.inFlight) return 'pending'
  const observed = p.observedAt == null ? NaN : Date.parse(p.observedAt)
  const changed = p.intentAt == null ? null : Date.parse(p.intentAt)
  if (p.fact === 'UNKNOWN' || !Number.isFinite(observed) || !Number.isFinite(p.now) ||
    !Number.isFinite(p.freshnessMs) || p.freshnessMs < 0 || observed > p.now || p.now - observed > p.freshnessMs ||
    (changed !== null && (!Number.isFinite(changed) || observed < changed))) return 'unknown'
  // A hold controls Nexus sends, not marketplace selling. No channel fact can verify that intent.
  if (p.intent === 'HELD') return 'unknown'
  const agrees = p.intent === 'LIVE' ? p.fact === 'SELLING'
    : p.intent === 'WITHDRAWN' ? p.fact === 'NOT_SELLING'
      : p.intent === 'NONE' || p.intent === 'DRAFT' || p.intent === 'RELEASED' ? p.fact === 'ABSENT'
        : p.fact === 'ABSENT' || p.fact === 'NOT_SELLING'
  return agrees ? 'agrees' : 'diverged'
}

export function presenceLine(p: Presence): {
  intent: PresenceMeta; fact: PresenceMeta; verdict: PresenceMeta; asOf: string | null; sentence: string
} {
  const intent = intentMeta(p.intent)
  const verdictName = presenceVerdict(p)
  const verdict = verdictMeta(verdictName)
  const observed = p.observedAt == null ? NaN : Date.parse(p.observedAt)
  const recorded = p.fact === 'REFUSED' || Number.isFinite(observed) ? factMeta(p.fact) : factMeta('UNKNOWN')
  // An old or unverified selling observation must not paint a current green fact.
  const fact = recorded.tone === 'success' && (verdictName === 'unknown' || verdictName === 'pending')
    ? { ...recorded, tone: 'neutral' as const, sentence: `Last observation: ${recorded.sentence} It is not a current verification.` }
    : recorded
  return { intent, fact, verdict, asOf: p.observedAt, sentence: `${intent.label} · ${fact.label}. ${intent.sentence} ${fact.sentence} ${verdict.sentence}` }
}
