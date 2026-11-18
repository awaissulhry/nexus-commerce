import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { REPLY_BATCH_MAX, REPLY_REFUSAL_WORDS } from '@nexus/factory-domain/threads/replies'
import type { ApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { boxState, composerModes, heldForNamesOther, heldReason, startDraft } from '../../../../lib/record-thread/composer/model'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import { postPortalReplyKeyed } from '../../../_shared/record-thread/api'
import type { OrderRow } from '../api'
import { LIST_ROWS } from '../_demo/fixtures'
import {
  keyFor,
  languageInSentence,
  portalStateOf,
  REPLY_MAX,
  replyComposerContext,
  replyManyHeld,
  replyManyLabel,
  replyOutcomeOf,
  replyReceipt,
  replyRound,
  replySendHeld,
  replyTargetsOf,
  sentOf,
  targetLabel,
  toSend,
  type ReplyManyModel,
  type ReplyResult,
  type ReplyTarget,
} from './reply-many'
import { NAMESPACE } from './sheet/model'
import { ReplyManyBody } from './view/ReplyManyDialog'

/**
 * F-SA-282 (sales page plan N5, picks P10, R7; 11-customer-page §3.8; review BW-6; rule 7 / T11): Reply to <customer> on N — never one
 * message to two customers. Held in words before the click when the ticks span customers, the window never opens on them, each order's
 * own conversation gets its own message (one call per order, one batchId), at most 50, the composer's text box in N mode (the portal
 * only, no files), the customer's language shown, the API's mis-send hold with the composer's own tick, and each order's answer: posted,
 * or not with why.
 */

const ALPHA = 'a1a1a1a1-0000-4000-8000-0000000000a1'
const BETA = 'b2b2b2b2-0000-4000-8000-0000000000b2'
const order = (n: number, partyId = ALPHA, partyName = BRAND_ALPHA.tradeName): OrderRow => ({ ...LIST_ROWS[n % LIST_ROWS.length]!, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, number: `SO-2026-${String(100 + n).padStart(4, '0')}`, partyId, partyName })
const alpha = [order(1), order(2), order(3)]
const beta = order(9, BETA, BRAND_BETA.tradeName)
const tFor = (locale: (typeof LOCALES)[number]) => createTranslator(locale, messagesFor(locale, [NAMESPACE])[NAMESPACE]!)

describe('F-SA-282: held before the click — one customer only, the right, at most 50', () => {
  it('the ticks of one customer pass; of two customers they are held in words (never one message to two customers)', () => {
    expect(replyManyHeld(alpha, null, true)).toBeNull()
    expect(replyManyHeld([...alpha, beta], null, true)).toEqual({ key: 'reply.oneCustomer' })
    expect(replyManyHeld([], null, true)).toBeNull()
  })
  it('on the customer page an order of another customer is held; no right and more than 50 are held too', () => {
    expect(replyManyHeld(alpha, ALPHA, true)).toBeNull()
    expect(replyManyHeld([beta], ALPHA, true)).toEqual({ key: 'bulk.notThisCustomer' })
    expect(replyManyHeld(alpha, null, false)).toEqual({ key: 'reply.noRight' })
    const fifty = Array.from({ length: 50 }, (_, n) => order(n))
    expect(replyManyHeld(fifty, null, true)).toBeNull()
    expect(replyManyHeld([...fifty, order(50)], null, true)).toEqual({ key: 'reply.tooMany', params: { max: 50 } })
  })
  it('the limit is the server\'s own (B-SA-073): one number, never two', () => {
    expect(REPLY_MAX).toBe(REPLY_BATCH_MAX)
    expect(REPLY_MAX).toBe(50)
  })
  it('the bar names the customer only when every tick is of that customer', () => {
    expect(replyManyLabel(alpha)).toEqual({ key: 'bulk.reply', params: { customer: BRAND_ALPHA.tradeName, count: 3 } })
    expect(replyManyLabel([...alpha, beta])).toEqual({ key: 'bulk.replyAny', params: { count: 4 } })
    expect(tFor('en')('bulk.reply', { customer: 'Brand Alpha', count: 6 })).toBe('Reply to Brand Alpha on 6…')
    expect(tFor('it')('bulk.reply', { customer: 'Brand Alpha', count: 6 })).toBe('Rispondi a Brand Alpha su 6…')
  })
  it('the hook refuses to open on two customers even if asked (the bar\'s check again), and the bar holds before the click', () => {
    const hook = readFileSync(new URL('./use-reply-many.ts', import.meta.url), 'utf8')
    expect(hook).toContain('if (rows.length === 0 || replyManyHeld(rows, locked, canPost)) return')
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('heldReason={replyWords}')
    expect(view).toContain('<ReplyManyDialog model={model.replyMany} actions={actions?.replyMany} />')
    const sheet = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('onReplyMany: (ids) => replyMany.open(pickedRows(ids), host.locked?.party ?? null)')
  })
})

describe('F-SA-282: the composer\'s text box in N mode (rule 24: the same box)', () => {
  it('the portal only (no office note, no mail), starting there; no right without the portal', () => {
    const context = replyComposerContext(BRAND_ALPHA.tradeName)
    expect(composerModes(context)).toEqual(['portal'])
    expect(startDraft(context).mode).toBe('portal')
    expect(boxState(context)).toBe('open')
    expect(composerModes({ ...context, portal: false })).toEqual([])
    expect(boxState({ ...context, portal: false })).toBe('noRight')
    // The one-record composer is unchanged (N mode is opt-in).
    expect(composerModes({ ...context, many: false })).toEqual(['note', 'portal'])
  })
  it('the API\'s hold of a text that names another customer is the composer\'s own: held until ticked or changed', () => {
    const context = replyComposerContext(BRAND_ALPHA.tradeName)
    const held = heldForNamesOther({ ...startDraft(context), body: 'As agreed with Brand Beta' })
    expect(heldReason(held, context)).toEqual({ key: 'held.namesOther' })
    expect(heldReason({ ...held, namesNoOtherCustomer: true }, context)).toBeNull()
  })
  it('no files: the window gives no clip (a file belongs to one order)', () => {
    const dialog = readFileSync(new URL('./view/ReplyManyDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain('context={replyComposerContext(customer)}')
    expect(dialog).not.toMatch(/\bclip=|\bonFiles=|\btray=/)
  })
})

describe('F-SA-282: one batch, each order\'s own conversation, one after the other', () => {
  it('each reply goes to its own order\'s conversation with the one batchId and its own key (nothing copied between orders)', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown>; key: string | undefined }> = []
    const api = { post: async (path: string, options: { body: Record<string, unknown>; idempotencyKey?: string }) => (calls.push({ path, body: options.body, key: options.idempotencyKey }), { message: { id: 'm' } }) } as unknown as ApiClient
    const batchId = 'c3c3c3c3-0000-4000-8000-0000000000c3'
    for (const target of replyTargetsOf(alpha)) await postPortalReplyKeyed(api, { type: 'SalesOrder', id: target.id }, { body: 'Ready on Friday.', attachments: [], batchId }, `key-${target.id}`)
    expect(calls.map((call) => call.path)).toEqual(alpha.map((row) => `/threads/SalesOrder/${row.id}/replies`))
    expect(calls.every((call) => call.body.batchId === batchId && call.body.body === 'Ready on Friday.' && Array.isArray(call.body.attachments) && (call.body.attachments as unknown[]).length === 0)).toBe(true)
    expect(new Set(calls.map((call) => call.key)).size).toBe(3)
    // Without a batch the one-record reply sends none (B-TH-237 unchanged).
    await postPortalReplyKeyed(api, { type: 'SalesOrder', id: alpha[0]!.id }, { body: 'x', attachments: [] }, 'k')
    expect(calls.at(-1)!.body).not.toHaveProperty('batchId')
  })
  it('the round posts one order at a time in the ticked order and stops at the text the API holds (names another customer)', async () => {
    const targets = replyTargetsOf(alpha)
    const seen: string[] = []
    const answers: Record<string, ReplyResult | 'namesOther'> = { [targets[0]!.id]: { state: 'sent' }, [targets[1]!.id]: 'namesOther', [targets[2]!.id]: { state: 'sent' } }
    const done: Array<[string, number]> = []
    const round = await replyRound(targets, async (target) => (seen.push(target.id), answers[target.id]!), (id, _result, count) => done.push([id, count]))
    expect(round).toEqual({ held: true, posted: 1 })
    expect(seen).toEqual([targets[0]!.id, targets[1]!.id]) // nothing more went after the hold
    expect(done).toEqual([[targets[0]!.id, 1]])
  })
  it('a full round: posted, refused with why and failed, each order answered once', async () => {
    const targets = replyTargetsOf(alpha)
    const answers: ReplyResult[] = [{ state: 'sent' }, { state: 'refused', why: { key: 'reply.why.closed' } }, { state: 'failed', why: { key: 'reply.why.failed' } }]
    const results: Record<string, ReplyResult> = {}
    const round = await replyRound(targets, async (target) => answers[targets.indexOf(target)]!, (id, result) => (results[id] = result))
    expect(round).toEqual({ held: false, posted: 1 })
    // Try again goes to the failed order only: a posted one is never posted twice, a refused one stays refused.
    expect(toSend(targets, results).map((target) => target.id)).toEqual([targets[2]!.id])
    expect(sentOf(targets, results).map((target) => target.id)).toEqual([targets[0]!.id])
    const receipt = replyReceipt(targets, results)
    expect(receipt.sent).toBe(1)
    expect(receipt.failed).toBe(1)
    expect(receipt.lines.map((line) => line.result?.state)).toEqual(['sent', 'refused', 'failed'])
  })
  it('a try with the same words keeps its key (a lost answer never posts twice); new words or the tick take a new one', () => {
    let n = 0
    const fresh = () => `k${++n}`
    const first = keyFor(undefined, 'Ready on Friday.', false, fresh)
    expect(keyFor(first, 'Ready on Friday.', false, fresh)).toBe(first)
    expect(keyFor(first, 'Ready on Monday.', false, fresh).key).toBe('k2')
    expect(keyFor(first, 'Ready on Friday.', true, fresh).key).toBe('k3')
  })
})

describe('F-SA-282: what each refusal says (the server\'s B-SA-073 refusals and the faults)', () => {
  it('the mis-send hold, one customer per batch, 50 at most, a closed conversation, no portal reader', () => {
    expect(replyOutcomeOf({ code: 'NAMES_OTHER_CUSTOMER', kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'namesOther' })
    expect(replyOutcomeOf({ code: 'BATCH_TWO_CUSTOMERS', kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.oneCustomer' } })
    expect(replyOutcomeOf({ code: 'BATCH_FULL', kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.tooMany', params: { max: 50 } } })
    expect(replyOutcomeOf({ code: 'CLOSED', kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.why.closed' } })
    expect(replyOutcomeOf({ code: 'NO_PORTAL', kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.why.noPortal', params: { customer: 'Brand Alpha' } } })
  })
  it('an order out of reach, no right, a refusal as it is; a fault is tried again', () => {
    expect(replyOutcomeOf({ code: null, kind: 'not_found' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.why.notFound' } })
    expect(replyOutcomeOf({ code: null, kind: 'forbidden' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.why.forbidden' } })
    expect(replyOutcomeOf({ code: null, kind: 'invalid' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.why.refused' } })
    expect(replyOutcomeOf({ code: null, kind: 'unavailable' }, 'Brand Alpha')).toEqual({ kind: 'failed', why: { key: 'reply.why.failed' } })
    expect(replyOutcomeOf({ code: null, kind: null }, 'Brand Alpha')).toEqual({ kind: 'failed', why: { key: 'reply.why.failed' } })
  })
  it('the browser\'s words for the server\'s refusals are the server\'s own (one sentence each)', () => {
    expect(tFor('en')('reply.oneCustomer')).toBe(REPLY_REFUSAL_WORDS.BATCH_TWO_CUSTOMERS.en)
    expect(tFor('it')('reply.oneCustomer')).toBe(REPLY_REFUSAL_WORDS.BATCH_TWO_CUSTOMERS.it)
    expect(tFor('en')('reply.tooMany', { max: 50 })).toBe(REPLY_REFUSAL_WORDS.BATCH_FULL.en)
    expect(tFor('it')('reply.tooMany', { max: 50 })).toBe(REPLY_REFUSAL_WORDS.BATCH_FULL.it)
  })
})

describe('F-SA-282: the portal and the language', () => {
  it('no portal: the switch off or nobody active; Send held in words naming the customer', () => {
    expect(portalStateOf(null)).toBe('unknown')
    expect(portalStateOf({ settings: { portalOn: false }, people: [{ status: 'ACTIVE' }] })).toBe('off')
    expect(portalStateOf({ settings: { portalOn: true }, people: [{ status: 'INVITED' }] })).toBe('off')
    expect(portalStateOf({ settings: { portalOn: true }, people: [{ status: 'ACTIVE' }] })).toBe('on')
    expect(replySendHeld('off', 'Brand Alpha', 3)).toEqual({ key: 'reply.portalOff', params: { customer: 'Brand Alpha' } })
    expect(replySendHeld('unknown', 'Brand Alpha', 3)).toBeNull()
    expect(replySendHeld('on', 'Brand Alpha', 0)).toEqual({ key: 'reply.nothingLeft' })
  })
  it('the language inside the sentence, as each language writes it', () => {
    expect(languageInSentence('it', 'en')).toBe('Italian')
    expect(languageInSentence('it', 'it')).toBe('italiano')
    expect(tFor('en')('reply.reads', { customer: 'Brand Alpha', language: 'Italian' })).toBe('Brand Alpha reads Italian')
    expect(tFor('it')('reply.reads', { customer: 'Brand Alpha', language: 'italiano' })).toBe('Brand Alpha legge in italiano')
  })
})

describe('F-SA-282: the window in both languages', () => {
  const targets: ReplyTarget[] = replyTargetsOf(alpha)
  const model = (more: Partial<ReplyManyModel> = {}): ReplyManyModel => ({
    customer: { id: ALPHA, name: BRAND_ALPHA.tradeName },
    targets,
    batchId: 'c3c3c3c3-0000-4000-8000-0000000000c3',
    draft: startDraft(replyComposerContext(BRAND_ALPHA.tradeName)),
    notes: [],
    language: 'it',
    portal: 'on',
    sending: false,
    progress: null,
    results: {},
    done: false,
    ...more,
  })
  it('who reads it, in which language, on which orders; each conversation its own message; no files; never another customer', () => {
    const text = textOf(render(createElement(ReplyManyBody, { model: model() }), 'en'))
    expect(text).toContain('Brand Alpha reads Italian')
    expect(text).toContain('Brand Alpha will read this on 3 orders:')
    for (const target of targets) expect(text).toContain(targetLabel(target))
    expect(text).toContain("Each order's conversation gets its own message")
    expect(text).toContain('No files here')
    expect(text).toContain('Post to Brand Alpha')
    expect(text).not.toContain(BRAND_BETA.tradeName)
    const italian = textOf(render(createElement(ReplyManyBody, { model: model() }), 'it'))
    expect(italian).toContain('Brand Alpha legge in italiano')
    expect(italian).toContain('Brand Alpha lo leggerà su 3 ordini:')
  })
  it('no portal: said in words; the language is left out when the reader may not read the customer (never guessed)', () => {
    const text = textOf(render(createElement(ReplyManyBody, { model: model({ portal: 'off', language: null }) }), 'en'))
    expect(text).toContain("Brand Alpha has no portal yet: write by e-mail in each order's conversation.")
    expect(text).not.toContain('reads Italian')
    expect(textOf(render(createElement(ReplyManyBody, { model: model({ portal: 'off' }) }), 'it'))).toContain("Brand Alpha non ha ancora il portale: scrivi per e-mail nella conversazione di ogni ordine.")
  })
  it('after a hold: what already went is said, the preview names only the orders still to post, the tick is offered', () => {
    const held = heldForNamesOther({ ...startDraft(replyComposerContext(BRAND_ALPHA.tradeName)), body: 'Ready on Friday.' })
    const text = textOf(render(createElement(ReplyManyBody, { model: model({ results: { [targets[0]!.id]: { state: 'sent' } }, draft: held }) }), 'en'))
    expect(text).toContain(`Already posted on 1 order: ${targetLabel(targets[0]!)}`)
    expect(text).toContain('Brand Alpha will read this on 2 orders:')
    expect(text).toContain('This text names no other customer')
  })
  it('the receipt: posted, or not posted with why, one line per order', () => {
    const results: Record<string, ReplyResult> = { [targets[0]!.id]: { state: 'sent' }, [targets[1]!.id]: { state: 'refused', why: { key: 'reply.why.closed' } }, [targets[2]!.id]: { state: 'failed', why: { key: 'reply.why.failed' } } }
    const text = textOf(render(createElement(ReplyManyBody, { model: model({ results, done: true }) }), 'en'))
    expect(text).toContain("Posted on 1 order: Brand Alpha reads it in that order's conversation.")
    expect(text).toContain(`${targetLabel(targets[0]!)} · Posted`)
    expect(text).toContain(`${targetLabel(targets[1]!)} · Not posted. Its conversation is closed: reopen it to reply.`)
    expect(text).toContain(`${targetLabel(targets[2]!)} · Not posted. It did not go through: try again.`)
  })
  it('every word in both languages (no key left) and the step\'s own words', () => {
    for (const locale of LOCALES) {
      const t = tFor(locale)
      const params = { customer: 'Brand Alpha', count: 2, max: 50, language: 'x', orders: 'SO-1', done: 1, why: 'x' }
      for (const key of ['reply.title', 'reply.oneCustomer', 'reply.noRight', 'reply.tooMany', 'reply.portalOff', 'reply.reads', 'reply.preview', 'reply.each', 'reply.noFiles', 'reply.already', 'reply.nothingLeft', 'reply.progress', 'reply.sending', 'reply.cancel', 'reply.close', 'reply.retry', 'reply.result.title', 'reply.result.none', 'reply.result.label', 'reply.result.sent', 'reply.result.notSent', 'reply.why.closed', 'reply.why.noPortal', 'reply.why.refused', 'reply.why.notFound', 'reply.why.forbidden', 'reply.why.failed', 'bulk.reply', 'bulk.replyAny']) {
        const words = t(key, params)
        expect(words, `${locale} ${key}`).not.toBe(key)
        expect(words, `${locale} ${key}`).not.toMatch(/\{/)
      }
    }
    expect(tFor('en')('reply.preview', { customer: 'Brand Alpha', count: 6 })).toBe('Brand Alpha will read this on 6 orders:')
    expect(tFor('it')('reply.preview', { customer: 'Brand Alpha', count: 6 })).toBe('Brand Alpha lo leggerà su 6 ordini:')
    expect(tFor('it')('reply.oneCustomer')).toBe('Rispondere a più ordini funziona per un cliente alla volta.')
  })
})
