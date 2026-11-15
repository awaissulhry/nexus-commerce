import { z } from 'zod'
import { NUDGE_REFUSALS, WAITING_KINDS } from '@nexus/factory-domain/insights/waiting'
import { recordAddress } from '../../../../lib/records/record-links'
import type { Loaded } from '../model'

/**
 * Today › Waiting on others (B-W2b-388; COL-035; design home.today `waiting-on` "What I asked for and still wait on — the half of
 * the work no ERP shows": "My approval requests not decided (with approver and age) · POs I sent not confirmed · external
 * messages with no reply in 3 working days · links sent and not opened. Each row: what, who I wait for, since when", verbs
 * "Nudge (sends a reminder in the record's thread, once a day at most) · Recall a request (W3) · Open"). GET
 * /home/waiting-on-others (B-W1-52, B-W2a-20's Nudge, B-W2b-388's mail and links); the words are the screen's own from the kind,
 * the record and whom I wait for (the API's sentence is English).
 */

const refusals = Object.keys(NUDGE_REFUSALS) as [keyof typeof NUDGE_REFUSALS, ...(keyof typeof NUDGE_REFUSALS)[]]

export const waitingSchema = z.object({
  asOf: z.string(),
  counts: z.object({ total: z.number().int(), byKind: z.array(z.object({ kind: z.enum(WAITING_KINDS), label: z.string(), count: z.number().int() })) }),
  items: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(WAITING_KINDS),
      record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
      companyId: z.string().nullable(),
      siteId: z.string().nullable(),
      partyId: z.string().nullable(),
      sentence: z.string(),
      waitingFor: z.string(),
      since: z.string(),
      ageDays: z.number().int(),
      due: z.string().nullable(),
      nudge: z.object({ allowed: z.boolean(), refusal: z.enum(refusals).nullable() }),
    }),
  ),
  live: z.object({ events: z.array(z.string()) }),
})
export type WaitingAnswer = z.infer<typeof waitingSchema>
export type WaitingItem = WaitingAnswer['items'][number]

export interface WaitingRow extends WaitingItem {
  readonly href: string
}

export interface WaitingModel {
  readonly rows: Loaded<{ readonly items: readonly WaitingRow[]; readonly asOf: string }>
  readonly now: number
  /** Why changing is held (offline, a change in flight): a message key of `home-mywork`, or null. */
  readonly held: string | null
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger'; readonly params?: Readonly<Record<string, string | number>> } | null
}

export const rowOf = (item: WaitingItem, prefix: string, built: ReadonlySet<string>): WaitingRow => ({
  ...item,
  href: `${prefix}${recordAddress({ type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId, siteId: item.siteId }, built)}`,
})

/** Whom I wait for, in words: an approver (people who may decide), or the party by its name. */
export function whoWords(row: Pick<WaitingItem, 'kind' | 'waitingFor'>): { readonly key: string; readonly name: string } {
  return row.kind === 'APPROVAL_REQUEST' ? { key: 'waiting.who.approver', name: '' } : { key: 'waiting.who.party', name: row.waitingFor }
}

/** Since when, in words: today, or for N days. */
export const sinceWords = (row: Pick<WaitingItem, 'ageDays'>): { readonly key: string; readonly count: number } => (row.ageDays === 0 ? { key: 'waiting.since.today', count: 0 } : { key: 'waiting.since.days', count: row.ageDays })

/** The Nudge of a row: only an approval I asked for; offered, or held with its reason (a message key), or none. */
export function nudgeOf(row: Pick<WaitingItem, 'kind' | 'nudge'>, held: string | null): { readonly offered: boolean; readonly held: string | null } {
  if (row.kind !== 'APPROVAL_REQUEST') return { offered: false, held: null }
  if (held) return { offered: true, held }
  if (!row.nudge.allowed) return { offered: true, held: `waiting.nudge.refusal.${row.nudge.refusal ?? 'OUTSIDE'}` }
  return { offered: true, held: null }
}
