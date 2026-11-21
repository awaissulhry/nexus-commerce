import type { Phrase } from '../../model'
import type { NotePreset } from '../../../../production/_shared/notes/model'
import type { OrderIssue } from './api'

/**
 * F-PT-103 (order PRODUCTION tab, 10-design §3 "People + Ask for an update", 18-lead-settles L3, L7) — who is on the order and the
 * update asks, without a screen.
 *
 *   Ask for an update   the production lane's ONE note dialog (NoteDialog) on THIS order: "Each record's supervisor" and "Needs an
 *                       answer" ticked, a starter question in the page's language. Office only: the customer never reads it. Shown
 *                       with threads.post only (Read-only has no Ask door, L7). No supervisor: it still goes — the production managers
 *                       get it after 1 working day (L3), with Assign supervisor… for who may.
 *   the asks line       from the order's issues (GET /production/issues?salesOrderId=&status=ALL): the newest open office ask
 *                       ("Asked 20 Nov 16:20 · Carlo Prova answers by 23 Nov", escalated: the escalation's own words), the latest
 *                       answered one ("Latest update · Carlo Prova · 20 Nov 14:10 · first line" — with the server's reply, B-PT-010;
 *                       without it only when it was answered), and how many questions wait (the list itself is Problems & holds').
 *
 * Nothing here names a worker: the asker, the answerer and who replied are office people inside this one order (B-PT-010's rule).
 */

/** An office ask that waits for its answer (the newest open one). */
export interface OpenAsk {
  readonly id: string
  readonly at: string
  /** Who asked (B-PT-010; null until the server sends it). */
  readonly by: string | null
  /** The day it is due (the task's: raise + 1 working day). */
  readonly due: string
  /** It went past its day and moved on (the API's words: "now with the backup" …); null: still with the supervisor. */
  readonly escalated: { readonly it: string; readonly en: string } | null
  /** Where it was asked, for "Show in the thread" (B-PT-010; null: no door). */
  readonly messageId: string | null
  /** Asked on a work order of the order (its number), not on the order itself. */
  readonly workOrder: string | null
}

/** The latest answered office ask. With the reply (B-PT-010): who, when, its first line; without it: only when it was answered. */
export interface LatestUpdate {
  readonly at: string
  readonly by: string | null
  readonly text: string | null
  readonly messageId: string | null
  /** L8: one answer answered the asks of other orders too (one note, one task) — those the reader may open, the rest counted. */
  readonly answeredFor: { readonly orders: readonly string[]; readonly more: number } | null
}

/** L8: "Answered for SEED-SO-0088, SEED-SO-0090 and 1 more" — null when the ask stood alone (or the server does not say). */
export function answeredForOf(batch: OrderIssue['batch']): LatestUpdate['answeredFor'] {
  const orders = (batch?.orders ?? []).map((order) => order.number)
  const more = batch?.more ?? 0
  return orders.length > 0 || more > 0 ? { orders, more } : null
}

export interface AsksView {
  readonly open: OpenAsk | null
  readonly latest: LatestUpdate | null
  /** Every open issue of the order — the update asks and the customer's questions ("2 questions wait for an answer"). */
  readonly waiting: number
}

export const NO_ASKS: AsksView = Object.freeze({ open: null, latest: null, waiting: 0 })

/** The longest first line the screen quotes of an answer (the rest is in the thread). */
export const QUOTE_MAX = 140

/** The first line of a text, at most QUOTE_MAX characters ("…" when cut); null for none. */
export function firstLineOf(text: string | null | undefined): string | null {
  const line = (text ?? '').split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  if (!line) return null
  return line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1).trimEnd()}…` : line
}

const newest = (a: string | null, b: string | null): number => (b ?? '').localeCompare(a ?? '')

/** The asks line of the order's issues (any order the list came in). */
export function asksOf(issues: readonly OrderIssue[] | null | undefined): AsksView {
  if (!issues || issues.length === 0) return NO_ASKS
  const office = issues.filter((issue) => issue.source === 'OFFICE')
  const open = [...office].filter((issue) => issue.status === 'OPEN').sort((a, b) => newest(a.raisedAt, b.raisedAt))[0] ?? null
  const answered = [...office].filter((issue) => issue.status === 'ANSWERED').sort((a, b) => newest(a.reply?.at ?? a.answeredAt, b.reply?.at ?? b.answeredAt))[0] ?? null
  return {
    open: open
      ? {
          id: open.id,
          at: open.raisedAt,
          by: open.askedBy?.name ?? null,
          due: open.dueOn,
          escalated: open.escalation && open.escalation.step > 0 ? open.escalation.words : null,
          messageId: open.messageId ?? null,
          workOrder: open.record.type === 'WorkOrder' ? open.record.label : null,
        }
      : null,
    latest:
      answered && (answered.reply || answered.answeredAt)
        ? answered.reply
          ? { at: answered.reply.at, by: answered.reply.by?.name ?? null, text: firstLineOf(answered.reply.excerpt), messageId: answered.reply.messageId, answeredFor: answeredForOf(answered.batch) }
          : { at: answered.answeredAt!, by: null, text: null, messageId: null, answeredFor: answeredForOf(answered.batch) }
        : null,
    waiting: issues.filter((issue) => issue.status === 'OPEN').length,
  }
}

// ---- the ready ask (the note dialog's preset) ----------------------------------------------------------------------------------

/** What "Ask for an update" opens the note dialog with: its title, the starter question, its Send word (orders catalogue phrases). */
export interface AskStarter {
  readonly title: Phrase
  readonly body: Phrase
  readonly send: Phrase
}

/**
 * The starter of an ask about the order (the promise named when there is one) or about one of its work orders (its due day named):
 * "Where is SO-0002 now? What is cut, sewn and packed? Any problem? Is the promise of 7 Dec still safe?". `day` says a day in the
 * page's way. The supervisor is mentioned by the dialog's own tick ("Each record's supervisor"), never typed into the text.
 */
export function askStarterOf(input: { readonly number: string; readonly promise: string | null; readonly workOrder?: { readonly number: string; readonly due: string | null } | null }, day: (value: string) => string): AskStarter {
  const send: Phrase = { key: 'productionTab.ask.send' }
  const wo = input.workOrder ?? null
  if (wo) {
    return {
      title: { key: 'productionTab.ask.titleAbout', params: { number: wo.number } },
      body: wo.due ? { key: 'productionTab.ask.starterWo', params: { number: wo.number, due: day(wo.due) } } : { key: 'productionTab.ask.starterWoNoDue', params: { number: wo.number } },
      send,
    }
  }
  return {
    title: { key: 'productionTab.ask.title', params: { number: input.number } },
    body: input.promise ? { key: 'productionTab.ask.starter', params: { number: input.number, promise: day(input.promise) } } : { key: 'productionTab.ask.starterNoPromise', params: { number: input.number } },
    send,
  }
}

/**
 * F-PT-103b (lead, one path per job): the ready ask in the page's words — ONE builder for every door that opens it (Production now,
 * a work order's row, the band ⋯, Overview's People card): its title, the starter question, Needs an answer ticked, its Send word.
 */
export function askPresetOf(t: (key: string, params?: Readonly<Record<string, string | number>>) => string, starter: AskStarter): NotePreset {
  return { title: t(starter.title.key, starter.title.params), body: t(starter.body.key, starter.body.params), needsAnswer: true, send: t(starter.send.key) }
}

/**
 * Who is on it: the supervisor and the backup (the production read's People), or nobody yet — then the ask still goes and the
 * production managers get it after 1 working day (L3). `people` null: the reader does not read People (no workorders.view): nothing.
 */
export type OnItView = { readonly kind: 'unread' } | { readonly kind: 'nobody' } | { readonly kind: 'supervisor'; readonly name: string; readonly me: boolean; readonly backup: string | null }

export function onItOf(people: { readonly supervisor: { readonly name: string; readonly me: boolean } | null; readonly backup: { readonly name: string } | null } | null | undefined): OnItView {
  if (!people) return { kind: 'unread' }
  if (!people.supervisor) return { kind: 'nobody' }
  return { kind: 'supervisor', name: people.supervisor.name, me: people.supervisor.me, backup: people.backup?.name ?? null }
}
