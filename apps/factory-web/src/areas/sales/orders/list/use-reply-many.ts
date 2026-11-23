'use client'

import { useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { heldReason, heldForNamesOther, namesNoOtherCustomerOf, startDraft } from '../../../../lib/record-thread/composer/model'
// F-CP-162 (B-CP-020): words that look like a price come back warned; "Send anyway" sends them with pricesInWordsOk (F-CP-147's flow).
import { heldForNamesPrice, pricesInWordsOkOf } from '../../../../lib/record-thread/composer/model'
import { postPortalReplyKeyed } from '../../../_shared/record-thread/api'
import { refusalCode } from '../../../_shared/record-thread/state'
import { getParty } from '../../../parties/_shared/api'
import { getPortalAccess } from '../../../admin/users/partners/api'
// F-CW-203: the customer's to-do beside the message — the existing ask command (POST /partners/:partyId/tasks, ANSWER_MESSAGE).
import { askPartner } from '../../../admin/users/partners/api'
import { endOfDay } from '../../../admin/users/partners/model'
import { romeToday } from '../model'
import {
  keyFor,
  portalStateOf,
  replyComposerContext,
  replyManyHeld,
  replyOutcomeOf,
  replyRound,
  replySendHeld,
  replyTargetsOf,
  todoHeld,
  todoLeft,
  todoOutcomeOf,
  todoStart,
  toSend,
  type ReplyKey,
  type ReplyRecordType, // F-CQ-304
  type ReplyRow, // F-CQ-304
  type ReplyManyActions,
  type ReplyManyModel,
  type ReplyResult,
  type ReplyTarget,
  type TodoResult,
} from './reply-many'

/**
 * F-SA-282 (sales page plan N5, picks P10, R7; 11-customer-page §3.8): Reply to <customer> on N… — the window's state and its calls,
 * for the Orders sheet (Sales › Orders and the customer page's Work tab). Opened only on the orders of ONE customer (the bar's hold,
 * checked again here), at most 50, with ONE new batchId. On opening it reads the customer's language (GET /parties/:id; not shown when
 * the reader may not read the customer) and, for who may read it (partners.view), whether the customer reads its portal at all
 * (GET /partners/:id: Send held in words when not). Send posts the composer's text in each order's own conversation, one call per
 * order (POST /threads/SalesOrder/:id/replies, the batchId on each, its own Idempotency-Key), one after the other; each order answers
 * posted or not with why. The API's mis-send check (NAMES_OTHER_CUSTOMER) stops the round and puts the text back held with the
 * composer's own tick (F-SA-282a); the next Send goes on to the orders still to post, the batch the same.
 * F-CP-162: the API's price warning (409 NAMES_A_PRICE) stops the round the same way: the typed text stays with the composer's warning
 * (no amount repeated), Send reads "Send anyway" and the next round sends the same words with `pricesInWordsOk: true`.
 */

// F-CW-203: `open(rows, locked, { todo: true })` — "Ask <customer> about N…": the same window with the to-do tick ON (only for a
// reader who may make a customer's to-dos: partners.tasks.manage; anyone else gets the plain reply and no tick).
// F-CQ-304: `options.recordType` — the records' own conversations (a quote, a request, a portal order; one per row when a function);
// absent: orders, exactly as before. The to-do of "Ask <customer> about N quotes" is the same call with that recordType.
export function useReplyMany(api: ApiClient, permissions: readonly string[], onPosted: () => void): { model: ReplyManyModel | null; open: (rows: readonly ReplyRow[], locked: string | null, options?: { readonly todo?: boolean; readonly recordType?: ReplyRecordType | ((row: ReplyRow) => ReplyRecordType) }) => void; actions: ReplyManyActions } {
  const [model, setModel] = useState<ReplyManyModel | null>(null)
  // The window as it is now (a round's answers come one after the other; a read for an earlier window is dropped by its batch).
  const current = useRef<ReplyManyModel | null>(null)
  const keys = useRef(new Map<string, ReplyKey>())
  // F-CW-203: one key per order's to-do and day (a try after a lost answer never makes two).
  const todoKeys = useRef(new Map<string, { readonly key: string; readonly due: string }>())
  const canPost = permissions.includes('threads.post')
  const readsPortal = permissions.includes('partners.view')
  const canTodo = permissions.includes('partners.tasks.manage') // F-CW-203

  const update = (batchId: string, change: (now: ReplyManyModel) => ReplyManyModel) => {
    const now = current.current
    if (!now || now.batchId !== batchId) return
    const next = change(now)
    current.current = next
    setModel(next)
  }

  const open = (rows: readonly ReplyRow[], locked: string | null, options?: { readonly todo?: boolean; readonly recordType?: ReplyRecordType | ((row: ReplyRow) => ReplyRecordType) }) => {
    // The bar holds these in words before the click; the window never opens on two customers all the same.
    if (rows.length === 0 || replyManyHeld(rows, locked, canPost)) return
    const targets = replyTargetsOf(rows, options?.recordType) // F-CQ-304: each record's own type (absent: orders)
    // F-CQ-304: the window's words follow the records' type (one type, else a request's: an Incoming batch of requests and portal orders).
    const recordType = targets[0]?.recordType
    const typed = recordType ? { recordType: targets.every((target) => target.recordType === recordType) ? recordType : ('Inquiry' as const) } : {}
    const customer = { id: targets[0]!.partyId, name: targets[0]!.partyName }
    const batchId = newIdempotencyKey()
    keys.current = new Map()
    todoKeys.current = new Map()
    const today = romeToday()
    const asked = canTodo && !!options?.todo // F-CW-203
    const next: ReplyManyModel = { customer, targets, batchId, draft: startDraft(replyComposerContext(customer.name)), notes: [], language: undefined, portal: readsPortal ? undefined : 'unknown', sending: false, progress: null, results: {}, done: false, todo: canTodo ? todoStart(asked, today) : null, asked, today /* F-CW-203 */, ...typed /* F-CQ-304 */ }
    current.current = next
    setModel(next)
    getParty(api, customer.id).then(
      (party) => update(batchId, (now) => ({ ...now, language: party.language })),
      () => update(batchId, (now) => ({ ...now, language: null })),
    )
    if (readsPortal) {
      getPortalAccess(api, customer.id).then(
        (access) => update(batchId, (now) => ({ ...now, portal: portalStateOf(access) })),
        () => update(batchId, (now) => ({ ...now, portal: 'unknown' })),
      )
    }
  }

  const send = async () => {
    const now = current.current
    if (!now || now.sending) return
    // F-CW-203: + the orders whose message is posted and whose to-do a fault stopped (their to-do alone, never the message again).
    const todoOnly = todoLeft(now.targets, now.results)
    const pending = [...toSend(now.targets, now.results), ...todoOnly]
    const context = replyComposerContext(now.customer.name)
    const todo = now.todo?.on ? now.todo : null
    if (replySendHeld(now.portal, now.customer.name, pending.length) || todoHeld(todo, now.today ?? romeToday())) return
    // A round that only makes to-dos posts no text: the composer's own holds (an empty box) do not apply to it.
    if (pending.length > todoOnly.length && heldReason(now.draft, context)) return
    const { batchId } = now
    const body = now.draft.body
    const ticked = namesNoOtherCustomerOf(now.draft)
    // F-CP-162: "Send anyway" after the price warning (only for the very words it warned about).
    const pricesOk = pricesInWordsOkOf(now.draft)
    update(batchId, (m) => ({ ...m, sending: true, done: false, progress: { done: 0, count: pending.length } }))
    // F-CW-203: one order's to-do "Answer our message", after its reply is posted — made, refused for good, or a fault.
    const todoOne = async (target: ReplyTarget, due: string): Promise<TodoResult> => {
      const kept = todoKeys.current.get(target.id)
      const key = kept && kept.due === due ? kept : { key: newIdempotencyKey(), due }
      todoKeys.current.set(target.id, key)
      try {
        await askPartner(api, now.customer.id, { kind: 'ANSWER_MESSAGE', recordType: target.recordType ?? 'SalesOrder' /* F-CQ-304 */, recordId: target.id, dueAt: due ? endOfDay(due) : null, ...(target.companyId ? { companyId: target.companyId } : {}) }, key.key)
        return { state: 'made' }
      } catch (error) {
        return todoOutcomeOf({ code: refusalCode(error), kind: isApiError(error) ? error.kind : null })
      }
    }
    // One order's reply: posted, refused or failed with why — or the hold of a text that names another customer of ours.
    const postOne = async (target: ReplyTarget): Promise<ReplyResult | 'namesOther' | /* F-CP-162 */ 'namesPrice'> => {
      // F-CW-203: its message is already posted — only its to-do is tried again.
      if (now.results[target.id]?.state === 'sent') return { state: 'sent', ...(todo ? { todo: await todoOne(target, todo.due) } : {}) }
      const key = keyFor(keys.current.get(target.id), body, ticked, newIdempotencyKey, pricesOk)
      keys.current.set(target.id, key)
      try {
        await postPortalReplyKeyed(api, { type: target.recordType ?? 'SalesOrder' /* F-CQ-304 */, id: target.id }, { body, attachments: [], batchId, ...(ticked ? { namesNoOtherCustomer: true } : {}), ...(pricesOk ? { pricesInWordsOk: true } : {}) /* F-CP-162 */ }, key.key)
        return { state: 'sent', ...(todo ? { todo: await todoOne(target, todo.due) } : {}) }
      } catch (error) {
        const outcome = replyOutcomeOf({ code: refusalCode(error), kind: isApiError(error) ? error.kind : null }, now.customer.name)
        // F-CP-162: the price warning stops the round like the names-another-customer hold.
        return outcome.kind === 'namesOther' || outcome.kind === 'namesPrice' ? outcome.kind : { state: outcome.kind, why: outcome.why }
      }
    }
    const { held, posted } = await replyRound(pending, postOne, (id, result, done) => update(batchId, (m) => ({ ...m, results: { ...m.results, [id]: result }, progress: { done, count: pending.length } })))
    // Held: the text names another customer of ours — it comes back held with the composer's tick "This text names no other customer".
    // F-CP-162: or its words look like a price — it comes back with the warning, and Send reads "Send anyway" (the text stays).
    update(batchId, (m) => ({ ...m, sending: false, progress: null, done: !held, ...(held === 'namesOther' ? { draft: heldForNamesOther(m.draft) } : held === 'namesPrice' ? { draft: heldForNamesPrice(m.draft) } : {}) }))
    if (posted > 0) onPosted()
  }

  const actions: ReplyManyActions = {
    onDraft: (draft, notes) => {
      const now = current.current
      if (now) update(now.batchId, (m) => ({ ...m, draft, notes }))
    },
    onSend: () => void send(),
    // F-CW-203: the tick or its day (not while a round runs).
    onTodo: (todo) => {
      const now = current.current
      if (now && now.todo && !now.sending) update(now.batchId, (m) => ({ ...m, todo }))
    },
    onClose: () => {
      // A round on its way finishes first: every order then says what happened to it.
      if (current.current?.sending) return
      current.current = null
      setModel(null)
    },
  }
  return { model, open, actions }
}
