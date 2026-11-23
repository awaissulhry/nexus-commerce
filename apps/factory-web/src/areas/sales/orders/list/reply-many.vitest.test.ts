import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { REPLY_BATCH_MAX, REPLY_REFUSAL_WORDS } from '@nexus/factory-domain/threads/replies'
import type { ApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { boxState, composerModes, heldForNamesOther, heldReason, startDraft } from '../../../../lib/record-thread/composer/model'
// F-CP-162: the price warning in N mode (the composer's own flow, F-CP-147).
import { draftAfter, heldForNamesPrice, pricesInWordsOkOf } from '../../../../lib/record-thread/composer/model'
import { designScreen as sheetScreen } from './fixtures'
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
  todoDueDefault,
  todoHeld,
  todoLeft,
  todoOutcomeOf,
  todoStart,
  toSend,
  type ReplyManyModel,
  type ReplyResult,
  type ReplyTarget,
} from './reply-many'
import { NAMESPACE } from './sheet/model'
import { ReplyManyBody } from './view/ReplyManyDialog'
import { addDays } from '../../../admin/users/partners/model' // F-CW-203

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
    // F-CW-202: Reply to N is an act of the bar's ONE rule (sheet/bar.ts): held by this same check with the right given — without
    // threads.post it is not drawn at all (S9).
    expect(readFileSync(new URL('./sheet/bar.ts', import.meta.url), 'utf8')).toContain('return sheet(replyManyHeld(rows, host.locked, true))')
    expect(view).toContain('reply: () => actions?.onReplyMany?.(pickedIds),')
    expect(view).toContain('<ReplyManyDialog model={model.replyMany} actions={actions?.replyMany} />')
    const sheet = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('onReplyMany: (ids, options) => replyMany.open(pickedRows(ids), host.locked?.party ?? null, options)') // F-CW-203: + the to-do tick
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
    // F-CP-162: the round says which hold stopped it (the names-another-customer hold, or the price warning).
    expect(round).toEqual({ held: 'namesOther', posted: 1 })
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

// ---- B-SA-070b: the preview names each order as the customer reads it — its own number ("Your order 12"), the office number beside it
describe('B-SA-070b: Reply to N\'s preview reads "Your order 12" (the customer\'s own number), the office number beside it', () => {
  it('a row with its own number: "Your order 12 (SO-…)"; one without: the office number and its PO, as before', async () => {
    const { previewLabel } = await import('./reply-many')
    const [first, second] = replyTargetsOf([{ ...order(1), customerSeq: 12 }, order(2)])
    expect(first!.customerSeq).toBe(12)
    expect(second!.customerSeq).toBeNull()
    const en = tFor('en')
    const it_ = tFor('it')
    expect(previewLabel(first!, en)).toBe(`Your order 12 (${first!.number})`)
    expect(previewLabel(first!, it_)).toBe(`Il vostro ordine 12 (${first!.number})`)
    expect(previewLabel(second!, en)).toBe(targetLabel(second!))
  })
  it('the window draws it; the receipt keeps the office number (the writer\'s own)', () => {
    const targets = replyTargetsOf([{ ...order(1), customerSeq: 12 }, { ...order(2), customerSeq: 13 }])
    const model: ReplyManyModel = { customer: { id: ALPHA, name: BRAND_ALPHA.tradeName }, targets, batchId: 'c3c3c3c3-0000-4000-8000-0000000000c3', draft: startDraft(replyComposerContext(BRAND_ALPHA.tradeName)), notes: [], language: 'it', portal: 'on', sending: false, progress: null, results: {}, done: false }
    const text = textOf(render(createElement(ReplyManyBody, { model }), 'en'))
    expect(text).toContain(`Your order 12 (${targets[0]!.number}), Your order 13 (${targets[1]!.number})`)
    const italian = textOf(render(createElement(ReplyManyBody, { model }), 'it'))
    expect(italian).toContain(`Il vostro ordine 12 (${targets[0]!.number})`)
  })
})
// ---- end B-SA-070b

// ── F-CP-162 (customer page lane, the money wall; the API's B-CP-020, the composer's F-CP-147) ──
describe('F-CP-162: Reply to N whose words look like a price — warned once, never blocked, "Send anyway"', () => {
  const targets: ReplyTarget[] = replyTargetsOf(alpha)
  const context = replyComposerContext(BRAND_ALPHA.tradeName)
  const typed = { ...startDraft(context), body: 'Ready on Friday, at the agreed 45 euro a piece.' }

  it('409 NAMES_A_PRICE is the price warning (not a refusal of the order); the other refusals as before', () => {
    expect(replyOutcomeOf({ code: 'NAMES_A_PRICE', kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'namesPrice' })
    expect(replyOutcomeOf({ code: 'NAMES_OTHER_CUSTOMER', kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'namesOther' })
    expect(replyOutcomeOf({ code: null, kind: 'conflict' }, 'Brand Alpha')).toEqual({ kind: 'refused', why: { key: 'reply.why.refused' } })
  })

  it('the round stops at the warning: nothing more goes, what went is kept, the held order is still to post', async () => {
    const seen: string[] = []
    const answers: Record<string, ReplyResult | 'namesOther' | 'namesPrice'> = { [targets[0]!.id]: { state: 'sent' }, [targets[1]!.id]: 'namesPrice', [targets[2]!.id]: { state: 'sent' } }
    const results: Record<string, ReplyResult> = {}
    const round = await replyRound(targets, async (target) => (seen.push(target.id), answers[target.id]!), (id, result) => (results[id] = result))
    expect(round).toEqual({ held: 'namesPrice', posted: 1 })
    expect(seen).toEqual([targets[0]!.id, targets[1]!.id])
    expect(toSend(targets, results).map((target) => target.id)).toEqual([targets[1]!.id, targets[2]!.id])
  })

  it('the typed text stays with the warning; "Send anyway" only for those very words (a change checks them again)', () => {
    const held = heldForNamesPrice(typed)
    expect(held.body).toBe(typed.body)
    expect(pricesInWordsOkOf(typed)).toBe(false)
    expect(pricesInWordsOkOf(held)).toBe(true)
    expect(pricesInWordsOkOf(draftAfter(held, { body: 'Ready on Friday.' }))).toBe(false)
    // never held by it (warn, never block)
    expect(heldReason(held, context)).toBeNull()
  })

  it('"Send anyway" is another request: a new key per order; again with the same words, the same key', () => {
    let n = 0
    const fresh = () => `k${++n}`
    const first = keyFor(undefined, typed.body, false, fresh)
    const anyway = keyFor(first, typed.body, false, fresh, true)
    expect(anyway.key).toBe('k2')
    expect(keyFor(anyway, typed.body, false, fresh, true)).toBe(anyway)
    expect(keyFor(anyway, typed.body, false, fresh).key).toBe('k3')
  })

  it('each order\'s reply carries pricesInWordsOk only after the warning (a first try never does), the batch the same', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = []
    const api = { post: async (_path: string, options: { body: Record<string, unknown> }) => (calls.push({ body: options.body }), { message: { id: 'm' } }) } as unknown as ApiClient
    const batchId = 'c3c3c3c3-0000-4000-8000-0000000000c3'
    await postPortalReplyKeyed(api, { type: 'SalesOrder', id: targets[0]!.id }, { body: typed.body, attachments: [], batchId }, 'k1')
    await postPortalReplyKeyed(api, { type: 'SalesOrder', id: targets[0]!.id }, { body: typed.body, attachments: [], batchId, pricesInWordsOk: true }, 'k2')
    expect(calls[0]!.body).not.toHaveProperty('pricesInWordsOk')
    expect(calls[1]!.body).toMatchObject({ pricesInWordsOk: true, batchId, body: typed.body })
    // the hook sends the flag from the box's warning (the composer's own rule), never on its own
    const hook = readFileSync(new URL('./use-reply-many.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const pricesOk = pricesInWordsOkOf(now.draft)')
    expect(hook).toContain("...(pricesOk ? { pricesInWordsOk: true } : {})")
    expect(hook).toContain("held === 'namesPrice' ? { draft: heldForNamesPrice(m.draft) }")
  })

  it('the window draws the warning and "Send anyway", in Italian and English; the warning repeats no amount', () => {
    const model: ReplyManyModel = { customer: { id: ALPHA, name: BRAND_ALPHA.tradeName }, targets, batchId: 'c3c3c3c3-0000-4000-8000-0000000000c3', draft: heldForNamesPrice(typed), notes: [], language: 'it', portal: 'on', sending: false, progress: null, results: { [targets[0]!.id]: { state: 'sent' } }, done: false }
    const en = textOf(render(createElement(ReplyManyBody, { model }), 'en'))
    expect(en).toContain('This reply names a price. Our people who do not see prices read this thread too. Send it anyway?')
    expect(en).toContain('Send anyway')
    expect(en).toContain('Brand Alpha will read this on 2 orders:')
    const italian = textOf(render(createElement(ReplyManyBody, { model }), 'it'))
    expect(italian).toContain('Questa risposta indica un prezzo. La leggono anche nostri colleghi che non vedono i prezzi. Inviarla comunque?')
    expect(italian).toContain('Invia comunque')
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['record-thread-send'])['record-thread-send']!)('namesPrice.reply')).not.toMatch(/\d/)
    // the dialog brings the warning's catalogue (the Office layout loads `shell` only)
    expect(readFileSync(new URL('./view/ReplyManyDialog.tsx', import.meta.url), 'utf8')).toContain("namespaces={[SHEET, 'record-thread-composer', 'record-thread-send']}")
  })

  it('the design cases are a Sales worker\'s (no price grain, no money on the rows)', () => {
    for (const id of ['cp-162-reply-price', 'cp-162-reply-price-one-sent']) {
      const found = sheetScreen.cases.find((entry) => entry.id === id)
      expect(found, id).toBeDefined()
      const model = found!.model as unknown as { role: string; list: { can: { price: boolean }; replyMany: ReplyManyModel } }
      expect(model.role).toBe('sales')
      expect(model.list.can.price).toBe(false)
      expect(pricesInWordsOkOf(model.list.replyMany.draft)).toBe(true)
    }
  })
})
// ── end F-CP-162 ──

// ---- F-CW-203 (customer Work tab plan §4; 10-design §4, §6 W3; lead settles S8, S37): "Ask <customer> about N…" = Reply to N with
// ONE tick — "Put it in their to-do list, answer by <date>". After each order's message is posted, one to-do "Answer our message" for
// the customer on that order; hidden without partners.tasks.manage; its result on the order's own line of the receipt.
describe('F-CW-203: the to-do tick of Reply to N', () => {
  const targets: ReplyTarget[] = replyTargetsOf(alpha)
  const TODAY = '2026-11-23' // a Monday
  const model = (more: Partial<ReplyManyModel> = {}): ReplyManyModel => ({ customer: { id: ALPHA, name: BRAND_ALPHA.tradeName }, targets, batchId: 'c3c3c3c3-0000-4000-8000-0000000000c3', draft: startDraft(replyComposerContext(BRAND_ALPHA.tradeName)), notes: [], language: 'it', portal: 'on', sending: false, progress: null, results: {}, done: false, today: TODAY, ...more })

  it('the tick starts ON from Ask ▾ and OFF from Reply to N; its day is three working days ahead (the weekend skipped)', () => {
    expect(todoStart(true, TODAY)).toEqual({ on: true, due: '2026-11-26' })
    expect(todoStart(false, TODAY)).toEqual({ on: false, due: '2026-11-26' })
    expect(todoDueDefault('2026-11-26')).toBe('2026-12-01') // Thursday → Friday, Monday, Tuesday
    expect(todoDueDefault('2026-11-27')).toBe('2026-12-02') // Friday → Monday, Tuesday, Wednesday
    expect(todoDueDefault('2026-11-28')).toBe('2026-12-02') // Saturday → the same three working days
  })

  it('the day holds Send only when it cannot be asked: not after today, or beyond what the API takes; no day at all is fine', () => {
    expect(todoHeld(null, TODAY)).toBeNull()
    expect(todoHeld({ on: false, due: '2020-01-01' }, TODAY)).toBeNull() // unticked: no to-do, no hold
    expect(todoHeld({ on: true, due: '' }, TODAY)).toBeNull()
    expect(todoHeld({ on: true, due: TODAY }, TODAY)).toEqual({ key: 'reply.todo.past' })
    expect(todoHeld({ on: true, due: '2026-11-20' }, TODAY)).toEqual({ key: 'reply.todo.past' })
    expect(todoHeld({ on: true, due: addDays(TODAY, 1) }, TODAY)).toBeNull()
    expect(todoHeld({ on: true, due: addDays(TODAY, 179) }, TODAY)).toBeNull()
    expect(todoHeld({ on: true, due: addDays(TODAY, 180) }, TODAY)).toEqual({ key: 'reply.todo.far', params: { max: 180 } })
  })

  it('a to-do that is not made never loses the message: refused for good with why, or a fault that Try again makes alone', () => {
    expect(todoOutcomeOf({ code: null, kind: 'forbidden' })).toEqual({ state: 'refused', why: { key: 'reply.todo.why.forbidden' } })
    expect(todoOutcomeOf({ code: null, kind: 'invalid' })).toEqual({ state: 'refused', why: { key: 'reply.why.refused' } })
    expect(todoOutcomeOf({ code: null, kind: 'unavailable' })).toEqual({ state: 'failed', why: { key: 'reply.why.failed' } })
    expect(todoOutcomeOf({ code: null, kind: null })).toEqual({ state: 'failed', why: { key: 'reply.why.failed' } })
    const results: Record<string, ReplyResult> = {
      [targets[0]!.id]: { state: 'sent', todo: { state: 'made' } },
      [targets[1]!.id]: { state: 'sent', todo: { state: 'failed', why: { key: 'reply.why.failed' } } },
      [targets[2]!.id]: { state: 'failed', why: { key: 'reply.why.failed' } },
    }
    // Try again: the message of the third, and ONLY the to-do of the second (a posted message is never posted twice).
    expect(toSend(targets, results).map((target) => target.id)).toEqual([targets[2]!.id])
    expect(todoLeft(targets, results).map((target) => target.id)).toEqual([targets[1]!.id])
    expect(replyReceipt(targets, results)).toMatchObject({ sent: 2, failed: 2, todos: 1 })
    // A to-do refused for good is not tried again.
    expect(todoLeft(targets, { [targets[0]!.id]: { state: 'sent', todo: { state: 'refused', why: { key: 'reply.why.refused' } } } })).toEqual([])
    // Without the tick nothing changes: the receipt counts no to-do.
    expect(replyReceipt(targets, { [targets[0]!.id]: { state: 'sent' } })).toMatchObject({ sent: 1, failed: 0, todos: 0 })
  })

  it('the window: the tick, its day and the sentence that says what the customer sees — not drawn without the right', () => {
    const asked = textOf(render(createElement(ReplyManyBody, { model: model({ todo: todoStart(true, TODAY), asked: true }) }), 'en'))
    expect(asked).toContain('Put it in their to-do list, answer by')
    expect(asked).toContain('Brand Alpha sees “Answer our message” under What waits for you.')
    expect(asked).toContain('Waiting on customer')
    const italian = textOf(render(createElement(ReplyManyBody, { model: model({ todo: todoStart(true, TODAY), asked: true }) }), 'it'))
    expect(italian).toContain('Mettilo nella loro lista di cose da fare, risposta entro il')
    expect(italian).toContain('Tocca al cliente')
    // No right to make a customer's to-dos (todo: null), or an older model without the field: no tick at all.
    for (const plain of [model({ todo: null }), model()]) expect(textOf(render(createElement(ReplyManyBody, { model: plain }), 'en'))).not.toContain('to-do list')
    // A day that cannot be asked is said in words beside Send.
    const dialog = readFileSync(new URL('./view/ReplyManyDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain('?? todoHeld(model.todo, today)')
    // F-CQ-304: the title in the records' own words (orders keep 'reply.askTitle' / 'reply.title': replyKey with no type).
    expect(dialog).toContain("title={s(replyKey(model.recordType, model.asked ? 'askTitle' : 'title'), { customer: model.customer.name, count: model.targets.length })")
  })

  it('the receipt says what became of each order\'s to-do on that order\'s own line', () => {
    const results: Record<string, ReplyResult> = {
      [targets[0]!.id]: { state: 'sent', todo: { state: 'made' } },
      [targets[1]!.id]: { state: 'sent', todo: { state: 'failed', why: { key: 'reply.why.failed' } } },
      [targets[2]!.id]: { state: 'sent' },
    }
    const text = textOf(render(createElement(ReplyManyBody, { model: model({ results, done: true, todo: todoStart(true, TODAY) }) }), 'en'))
    expect(text).toContain(`${targetLabel(targets[0]!)} · Posted · in their to-do list`)
    expect(text).toContain(`${targetLabel(targets[1]!)} · Posted · the to-do was not made. It did not go through: try again.`)
    expect(text).toContain(`${targetLabel(targets[2]!)} · Posted`)
    expect(text).not.toContain(`${targetLabel(targets[2]!)} · Posted ·`)
  })

  it('the hook: one to-do per order AFTER its reply, its own key, the order\'s company; only with partners.tasks.manage (source)', () => {
    const hook = readFileSync(new URL('./use-reply-many.ts', import.meta.url), 'utf8')
    expect(hook).toContain("const canTodo = permissions.includes('partners.tasks.manage') // F-CW-203")
    expect(hook).toContain('todo: canTodo ? todoStart(asked, today) : null')
    // F-CQ-304: the to-do names the record's own type (an order: SalesOrder, as before; a quote: Quote).
    expect(hook).toContain("await askPartner(api, now.customer.id, { kind: 'ANSWER_MESSAGE', recordType: target.recordType ?? 'SalesOrder' /* F-CQ-304 */, recordId: target.id, dueAt: due ? endOfDay(due) : null,")
    expect(hook).toContain("return { state: 'sent', ...(todo ? { todo: await todoOne(target, todo.due) } : {}) }")
    // A posted message is never posted again: only its to-do is tried.
    expect(hook).toContain("if (now.results[target.id]?.state === 'sent') return { state: 'sent', ...(todo ? { todo: await todoOne(target, todo.due) } : {}) }")
    // The ONE sheet hands the option through on every host; the existing ask command is used (no new route).
    const sheet = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('onReplyMany: (ids, options) => replyMany.open(pickedRows(ids), host.locked?.party ?? null, options)')
    expect(sheet).toContain("todo: session.permissions.includes('partners.tasks.manage') /* F-CW-203 */")
    const api = readFileSync(new URL('../../../admin/users/partners/api.ts', import.meta.url), 'utf8')
    expect(api).toContain("export const ASKABLE = ['UPLOAD_DOCUMENT', 'ANSWER_MESSAGE', 'SEND_MEASUREMENTS', 'REPORT_PROGRESS'] as const")
  })

  it('every new word in both languages (no key left)', () => {
    for (const locale of LOCALES) {
      const t = tFor(locale)
      for (const key of ['reply.todo.tick', 'reply.todo.date', 'reply.todo.noDate', 'reply.todo.hint', 'reply.todo.past', 'reply.todo.far', 'reply.todo.why.forbidden', 'reply.result.todoMade', 'reply.result.todoNot']) expect(t(key, { customer: 'Brand Alpha', max: 180, why: 'x' }), `${locale} ${key}`).not.toBe(key)
      for (const count of [1, 3]) expect(t('reply.askTitle', { customer: 'Brand Alpha', count }), `${locale} ${count}`).toContain('Brand Alpha')
    }
    expect(tFor('en')('reply.askTitle', { customer: 'Seed Racing', count: 3 })).toBe('Ask Seed Racing about 3 orders')
    expect(tFor('it')('reply.askTitle', { customer: 'Seed Racing', count: 3 })).toBe('Chiedi a Seed Racing su 3 ordini')
  })
})
// ---- end F-CW-203

// ---- F-CQ-304 (customer page › Quotes & incoming, 13-backend §11): Reply to N given a record type — the same window on quotes and on
// requests / portal orders: each record's own conversation, its own words ("on 3 quotes", "Your quote 3"); orders exactly as before.
import { previewLabel as previewOf, replyKey } from './reply-many'

describe('F-CQ-304: Reply to N given a record type', () => {
  it('a target keeps its type (absent: an order); a quote posts into ITS conversation, the same batch and body', async () => {
    expect(replyTargetsOf(alpha).every((target) => target.recordType === undefined)).toBe(true)
    const quotes = replyTargetsOf(alpha, 'Quote')
    expect(quotes.map((target) => target.recordType)).toEqual(['Quote', 'Quote', 'Quote'])
    const mixed = replyTargetsOf(alpha.slice(0, 2), (row) => (row.id === alpha[0]!.id ? 'Inquiry' : 'PortalOrderRequest'))
    expect(mixed.map((target) => target.recordType)).toEqual(['Inquiry', 'PortalOrderRequest'])
    const calls: string[] = []
    const api = { post: async (path: string) => (calls.push(path), { message: { id: 'm' } }) } as unknown as ApiClient
    for (const target of quotes) await postPortalReplyKeyed(api, { type: target.recordType ?? 'SalesOrder', id: target.id }, { body: 'x', attachments: [], batchId: 'b' }, `k-${target.id}`)
    expect(calls).toEqual(alpha.map((row) => `/threads/Quote/${row.id}/replies`))
    // The hook posts and makes the to-do with the target's own type (an order: SalesOrder).
    const hook = readFileSync(new URL('./use-reply-many.ts', import.meta.url), 'utf8')
    expect(hook).toContain("await postPortalReplyKeyed(api, { type: target.recordType ?? 'SalesOrder' /* F-CQ-304 */, id: target.id },")
  })

  it('the words by type: orders keep theirs; a quote and a request have their own, in both languages ("Your quote 3 (…)")', () => {
    expect(replyKey(undefined, 'title')).toBe('reply.title')
    expect(replyKey('SalesOrder', 'preview')).toBe('reply.preview')
    expect(replyKey('Quote', 'askTitle')).toBe('reply.byType.quote.askTitle')
    expect(replyKey('PortalOrderRequest', 'each')).toBe('reply.byType.request.each')
    for (const locale of LOCALES) {
      const say = tFor(locale)
      for (const type of ['Quote', 'Inquiry'] as const) {
        for (const key of ['title', 'askTitle', 'preview', 'already', 'result.title']) expect(say(replyKey(type, key), { customer: 'Brand Alpha', count: 2, orders: 'x' }), `${locale} ${type} ${key}`).not.toMatch(/reply\.|\{/)
        for (const key of ['each', 'result.label']) expect(say(replyKey(type, key)), `${locale} ${type} ${key}`).not.toMatch(/reply\.|\{/)
        expect(say(replyKey(type, 'todo.hint'), { customer: 'Brand Alpha' }), `${locale} ${type}`).toContain('Brand Alpha')
      }
      expect(previewOf({ number: 'SEED-QT-0012', customerRef: null, customerSeq: 3, recordType: 'Quote' }, say), locale).toBe(locale === 'en' ? 'Your quote 3 (SEED-QT-0012)' : 'Il vostro preventivo 3 (SEED-QT-0012)')
      expect(previewOf({ number: 'SEED-INQ-0007', customerRef: null, customerSeq: 7, recordType: 'Inquiry' }, say), locale).toBe(locale === 'en' ? 'Your request 7 (SEED-INQ-0007)' : 'La vostra richiesta 7 (SEED-INQ-0007)')
      expect(previewOf({ number: 'SO-1', customerRef: null, customerSeq: 12 }, say), locale).toBe(say('reply.yourOrder', { seq: 12, number: 'SO-1' }))
    }
  })
})
// ---- end F-CQ-304

// ---- cq fx3 W2-2 (walk: the window on requests said "each order's conversation" and offered a portal-only box with no portal): the
// window's lines follow the record type; with no portal there is no box that says "they read it in their portal".
describe('cq fx3 W2-2: the Reply window on requests and quotes', () => {
  const model = (more: Partial<ReplyManyModel> = {}): ReplyManyModel => ({ customer: { id: ALPHA, name: BRAND_ALPHA.tradeName }, targets: replyTargetsOf(alpha), batchId: 'c3c3c3c3-0000-4000-8000-0000000000c3', draft: startDraft(replyComposerContext(BRAND_ALPHA.tradeName)), notes: [], language: 'it', portal: 'on', sending: false, progress: null, results: {}, done: false, ...more })
  it('no portal: the line names the records\' own conversations, and no portal-only box is drawn', () => {
    const off = textOf(render(createElement(ReplyManyBody, { model: model({ portal: 'off', recordType: 'Inquiry' }) }), 'en'))
    expect(off).toContain("Brand Alpha has no portal yet: write by e-mail in each request's conversation.")
    expect(off).not.toContain("each order's conversation")
    expect(off).not.toContain('No files here')
    const quote = textOf(render(createElement(ReplyManyBody, { model: model({ portal: 'off', recordType: 'Quote' }) }), 'it'))
    expect(quote).toContain('nella conversazione di ogni preventivo')
  })
  it('with a portal: the files line names the record type too; orders keep their words', () => {
    expect(textOf(render(createElement(ReplyManyBody, { model: model({ recordType: 'Inquiry' }) }), 'en'))).toContain("No files here: a file belongs to one request, so add it in that request's conversation.")
    expect(textOf(render(createElement(ReplyManyBody, { model: model() }), 'en'))).toContain("No files here: a file belongs to one order, so add it in that order's conversation.")
    for (const locale of LOCALES) for (const type of ['Quote', 'Inquiry'] as const) for (const key of ['portalOff', 'noFiles']) expect(tFor(locale)(replyKey(type, key), { customer: 'Brand Alpha' }), `${locale} ${type} ${key}`).not.toMatch(/reply\.|\{/)
  })
})
// ---- end cq fx3 W2-2
