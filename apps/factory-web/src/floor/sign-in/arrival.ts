import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { floorRead, type TaskOutcome } from '../tasks/shared/task-api'
import { offeredItem, type OpenItem, type OpenWork } from '../tasks/clock/model'

/**
 * Sign-in's welcome cards (design floor.signin "Welcome and checks"; MES-033, MES-117): after a new PIN and the worker
 * notice, only when needed and in this order: the line's handover note if new since the last shift (one "Seen": nothing
 * is stored per person, the next session starts after it), "Continue bundle B-000123 at Op 30?" after a clock-out paused
 * it, else Home. A read that fails shows no card: it never stands between a worker and Home.
 */

const note = z.object({
  id: z.string(),
  shiftDate: z.string(),
  shiftLabel: z.string(),
  topics: z.array(z.object({ topic: z.string(), tone: z.string(), labelIt: z.string(), labelEn: z.string() })),
  text: z.string().nullable(),
})
const newNotes = z.object({ line: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), notes: z.array(note) })
export type HandoverNews = z.infer<typeof newNotes>

export function fetchNewHandover(api: ApiClient): Promise<TaskOutcome<HandoverNews>> {
  return floorRead(api, '/production/dispatch/handover/new', { schema: newNotes })
}

export type WelcomeCard = { readonly kind: 'handover'; readonly line: string | null; readonly notes: HandoverNews['notes'] } | { readonly kind: 'continue'; readonly item: OpenItem }

/** The cards of this sign-in, in the design's order; empty: straight to Home. */
export function welcomeCards(news: HandoverNews | null, open: OpenWork | null): WelcomeCard[] {
  const cards: WelcomeCard[] = []
  if (news && news.notes.length > 0) cards.push({ kind: 'handover', line: news.line?.name ?? null, notes: news.notes })
  const item = offeredItem(open)
  if (item) cards.push({ kind: 'continue', item })
  return cards
}
