import { CALL_LIMITS } from '@nexus/factory-domain/production/calls/rules'
import type { FloorTone } from '@nexus/ui/floor'
import type { Locale } from '../../../lib/i18n/locales'
import { reasonWords } from '../../../lib/line-board/model'
import type { QueueItem } from '../../queue/model'
import type { CallType, HelpCall, HelpStation } from './api'

/**
 * Call for help's rules (SCR-172; design floor.help, MES-142, -143, -145). Pure, so the tests hold them: a tile's words
 * and tone, one tap never makes a second call (the station's open call, or the call waiting in this tablet's queue), the
 * four steps of "Who is coming", and who the card names (a floor responder by name; an office responder as "the office").
 */

export const CALL_SEND = 'andon.call.send'
export const CALL_ANSWER = 'andon.call.answer'
export const NOTE_MAX = CALL_LIMITS.note
/** The elapsed time turns amber at the office's "waiting" mark, red at twice that. */
export const WARN_AFTER_MS = CALL_LIMITS.waitingMinutes * 60_000
export const DANGER_AFTER_MS = 2 * WARN_AFTER_MS

export const callWords = (type: Pick<CallType, 'code' | 'labelIt' | 'labelEn' | 'labelI18n'>, locale: Locale): string => reasonWords(type, locale)

const COLOUR_TONE: Readonly<Record<string, FloorTone>> = { '#e5484d': 'danger', '#b87503': 'warning', '#ea580c': 'warning', '#1f6fde': 'info', '#6366f1': 'info', '#8b5cf6': 'info', '#059669': 'success' }

/** A tile's tone from its code's colour: never alone (each tile has its icon and word). */
export const callTone = (type: Pick<CallType, 'colour'>): FloorTone => (type.colour ? (COLOUR_TONE[type.colour.toLowerCase()] ?? 'neutral') : 'neutral')

/** A call waiting in this tablet's queue (no answer from the office yet). */
export interface QueuedCall {
  readonly clientEventId: string
  readonly typeId: string
  readonly at: string
}

/** The calls saved on this tablet and not yet recorded (a second tap shows it, never a second call: MES-143). */
export function queuedCalls(items: readonly Pick<QueueItem, 'kind' | 'state' | 'clientEventId' | 'payload' | 'occurredAt'>[]): QueuedCall[] {
  return items.flatMap((item) => (item.kind === CALL_SEND && item.state === 'waiting' && typeof item.payload.typeId === 'string' ? [{ clientEventId: item.clientEventId, typeId: item.payload.typeId, at: item.occurredAt }] : []))
}

export type TilePress = { readonly kind: 'open'; readonly callId: string } | { readonly kind: 'queued'; readonly clientEventId: string } | { readonly kind: 'send'; readonly type: CallType }

/** What one tap on a tile does: shows the open call, shows the one still on this tablet, or sends. */
export function tilePress(tile: HelpStation['tiles'][number], queued: readonly QueuedCall[]): TilePress {
  if (tile.open) return { kind: 'open', callId: tile.open.id }
  const waiting = queued.find((call) => call.typeId === tile.type.id)
  return waiting ? { kind: 'queued', clientEventId: waiting.clientEventId } : { kind: 'send', type: tile.type }
}

/** The payload of a queued call: the type alone (station and person are the tablet's). */
export const sendPayload = (type: Pick<CallType, 'id'>): Record<string, unknown> => ({ typeId: type.id })

/** The payload of a queued close (the station's "It's solved" or "Cancel call"). */
export const closePayload = (call: Pick<HelpCall, 'id'>, step: 'SOLVED' | 'CANCELLED'): Record<string, unknown> => ({ callId: call.id, step })

export const SHOWN_STEPS = ['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED'] as const
export type ShownStep = (typeof SHOWN_STEPS)[number]

export interface ProgressRow {
  readonly step: ShownStep
  /** When it happened; null: not yet. */
  readonly at: string | null
  /** Who took it, where the card may say (null: nobody named). */
  readonly by: Who | null
}

/** Who the card names: a floor person by name, an office colleague as the office; the team when it is known. */
export interface Who {
  readonly name: string | null
  readonly office: boolean
}

const whoOf = (by: NonNullable<HelpCall['coming']>['by']): Who | null => (by ? { name: by.name, office: by.kind === 'USER' } : null)

/** Sent → Seen → On the way → Solved, each with its time (MES-145). */
export function progressOf(call: Pick<HelpCall, 'timeline'>): ProgressRow[] {
  return SHOWN_STEPS.map((step) => {
    const row = call.timeline.find((entry) => entry.step === step)
    return { step, at: row?.at ?? null, by: row ? whoOf(row.by) : null }
  })
}

/** Who is coming now ("Paolo · maintenance · on the way"), or null while nobody has seen the call. */
export function comingOf(call: Pick<HelpCall, 'coming'>): { readonly who: Who; readonly team: string | null; readonly step: 'SEEN' | 'ON_THE_WAY' } | null {
  if (!call.coming) return null
  return { who: whoOf(call.coming.by) ?? { name: null, office: false }, team: call.coming.team?.name ?? null, step: call.coming.step }
}

/** The first read in which a call's helper is on the way (the success sound plays once per call). */
export function newlyOnTheWay(before: readonly Pick<HelpCall, 'id' | 'status'>[], after: readonly Pick<HelpCall, 'id' | 'status'>[]): boolean {
  return after.some((call) => call.status === 'ON_THE_WAY' && before.some((known) => known.id === call.id && known.status !== 'ON_THE_WAY'))
}

/** What follows a sent call in the design: the machine's symptom step, or the incident report. */
export function followUpOf(type: Pick<CallType, 'kind' | 'code'>): 'machine' | 'incident' | null {
  if (type.code === 'SAFETY') return 'incident'
  return type.kind === 'MACHINE' || type.kind === 'MAINTENANCE' ? 'machine' : null
}

/** Why "Add details" cannot send now, or null. */
export function detailsHeld(words: string, online: boolean): 'offline' | 'empty' | null {
  if (!online) return 'offline'
  return words.trim() === '' ? 'empty' : null
}

/** The refusals this screen has its own words for; any other shows the API's. */
export const KNOWN_REFUSALS = ['NO_STATION', 'OTHER_STATION', 'TYPE_INACTIVE', 'NOT_THIS_STATION', 'SOLVED', 'CANCELLED'] as const
export const isKnownRefusal = (code: string): boolean => (KNOWN_REFUSALS as readonly string[]).includes(code)
