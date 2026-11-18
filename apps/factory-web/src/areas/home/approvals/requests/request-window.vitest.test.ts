import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES, type Locale } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { leftKeys, render, textOf } from '../../../../lib/record-thread/parts/testing'
import { designScreen } from '../fixtures'
import { openIdOf } from '../inbox'
import type { InboxViewModel } from '../model'
import { REQUEST_CASES, REQUEST_FIXTURES } from './fixtures'
// F-SA-240: the window from four doors — its own props, the door's list, the door's parts.
import { answerProblem, doorAddress, doorListOf, doorTargetOf, KNOWN_REQUEST_REFUSALS } from './model'
import { RequestDoorNoticeBanner, RequestDoorWindow, RequestReview, type RequestDoorParts, type RequestReviewProps } from './view/RequestReview'

// The DS windows open only in a browser (after hydration, in a portal): here they draw in place — the window's title, subtitle,
// meta, its error, its content and its footer's buttons; a review's title, rows, lead and Save; a dialog's title, body and footer.
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  // F-SA-240: the ‹ › arrows drawn as "n of N" (the list the window walks), none without a list of 2 or more.
  const DetailModal = ({ open, title, subtitle, meta, actions, error, children, nav }: { open: boolean; title?: unknown; subtitle?: unknown; meta?: unknown; actions?: unknown; error?: unknown; children?: unknown; nav?: { ids: readonly string[]; current: string } }) =>
    open
      ? createElement(
          'section',
          { role: 'dialog', 'data-window': '' },
          createElement('h2', null, title as never),
          createElement('p', null, subtitle as never),
          meta as never,
          nav ? createElement('p', { 'data-nav': '' }, `${nav.ids.indexOf(nav.current) + 1} of ${nav.ids.length}`) : null,
          error ? createElement('p', { 'data-error': '' }, error as never) : null,
          children as never,
          createElement('footer', null, actions as never),
        )
      : null
  const ReviewChangesModal = ({ open, title, summary, changes, lead, saveLabel, state, problems }: { open: boolean; title?: unknown; summary?: unknown; changes: readonly { id: string; where?: unknown; what: unknown; now: unknown; next: unknown }[]; lead?: unknown; saveLabel?: string; state?: { phase: string; results?: Record<string, { words: string }> }; problems?: readonly string[] }) =>
    open
      ? createElement(
          'section',
          { role: 'dialog', 'data-review': '' },
          createElement('h2', null, title as never),
          createElement('p', null, summary as never),
          lead as never,
          ...changes.map((change) => createElement('p', { key: change.id, 'data-change': change.id }, change.where as never, ' · ', change.what as never, ' · ', change.now as never, ' → ', change.next as never)),
          ...Object.entries(state?.phase === 'done' ? (state.results ?? {}) : {}).map(([id, result]) => createElement('p', { key: `r-${id}`, 'data-result': id }, result.words)),
          ...(problems ?? []).map((problem, index) => createElement('p', { key: `p-${index}`, 'data-problem': '' }, problem)),
          createElement('button', { type: 'button' }, saveLabel),
        )
      : null
  return { ...actual, DetailModal, ReviewChangesModal }
})
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-PR-08 — a customer's request in Home › Approvals' review window, drawn (production plan §3, §5; lead picks L4, L26; review fixes
 * R-23, R-64): every design case in both languages with no key left on screen; "Urgent – asked" with its two accepts; a cancel answered
 * by Sales with what is already fixed and its fee for a price reader; a batch as one window (each order alone, Accept all re-checked);
 * the notice's "Lift the hold" / "Clear rush" (never a generic undo); and PW-H01b: another customer's request opens "not there any
 * more", naming no customer and no order.
 */

const View = designScreen.view as ComponentType<{ model: unknown }>
const caseOf = (id: string) => {
  const found = designScreen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return found.model
}
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => render(createElement(View, { model: caseOf(id) }), locale)
/** The first window drawn (the review window, a dialog): its own text only, never the list behind it (sections nest inside it). */
const windowOf = (html: string, marker = 'data-window=""') => {
  const at = html.indexOf(marker)
  if (at < 0) return ''
  const start = html.lastIndexOf('<section', at)
  const tags = /<section\b|<\/section>/g
  tags.lastIndex = start
  let depth = 0
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0] === '</section>' ? -1 : 1
    if (depth === 0) return textOf(html.slice(start, tag.index + tag[0].length))
  }
  return textOf(html.slice(start))
}
const PREFIXES = ['customerRequest', 'parts', 'notice', 'row', 'rule', 'kind', 'inbox', 'held', 'review', 'refusal', 'problem']
const { RUSH, HOLD, CANCEL } = REQUEST_FIXTURES

describe('F-PR-08: every case of the customer request window draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-030 · F-PR-08 in ${locale}`, () => {
      const ids = REQUEST_CASES.map((entry) => entry.id)
      expect(ids.length).toBeGreaterThan(12)
      for (const id of ids) {
        const html = draw(id, locale)
        expect(html.length, id).toBeGreaterThan(200)
        expect(leftKeys(html, PREFIXES), `${id} (${locale})`).toEqual([])
      }
    })
  }

  it('made-up data only: no real address, no mail, no path', () => {
    const text = JSON.stringify(REQUEST_CASES)
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|it|net)/i)
    expect(text).not.toMatch(/\/Users\//)
  })
})

describe('the window of one request', () => {
  it('"Urgent – asked" has two accepts (R-64), with Suggest something else and Refuse; what each accept does is said', () => {
    const en = windowOf(draw('f-pr-08-rush'))
    expect(en).toContain('Urgent – asked · SO-DEMO-0101')
    expect(en).toContain('Brand Alpha · PO PO-ALPHA-1')
    for (const word of ['Accept as urgent', 'Accept and rush the floor', 'Suggest something else', 'Refuse']) expect(en).toContain(word)
    expect(en).toContain('it moves only among that customer’s own orders')
    expect(en).toContain('its work orders go first on every tablet')
    // The customer's words, the need-by date and the earliest date read now.
    expect(en).toContain(RUSH.note!)
    expect(en).toContain('Needed by')
    expect(en).toContain('The earliest date we see now is 8 Dec')
    const it_ = windowOf(draw('f-pr-08-rush', 'it'))
    for (const word of ['Accetta come urgente (cliente)', 'Accetta e segna urgente in reparto', 'Proponi altro', 'Rifiuta', 'Urgente – richiesto']) expect(it_).toContain(word)
  })

  it('the words the customer reads, with their preview; none yet: the customer reads only the answer', () => {
    expect(windowOf(draw('f-pr-08-rush'))).toContain('No words yet: the customer reads only the answer.')
    expect(windowOf(draw('f-pr-08-rush-words'))).toContain('The customer reads: “We cannot make 10 December; 15 December is possible.”')
  })

  it('a cancel: Sales answers it; what is already fixed, a price that applies and its amount for a price reader; the line asked', () => {
    const en = windowOf(draw('f-pr-08-cancel'))
    expect(en).toContain('Cancel · SO-DEMO-0103')
    expect(en).toContain('Sales answers it')
    expect(en).toContain('Line 2 · M: cut already — a price applies')
    expect(en).toMatch(/€\s?360\.00/)
    expect(en).toContain('Line 2 · JKT-DEMO-02 · NERO · the whole line')
    expect(en).toContain('Their reason: Ordered twice by mistake')
    // A single accept for a kind that is not "Urgent – asked".
    expect(en).not.toContain('Accept and rush the floor')
    expect(en).toContain('Accept')
  })

  it('a counter the customer said yes to: Accept carries it out; their words and our offer show', () => {
    const en = windowOf(draw('f-pr-08-agreed'))
    expect(en).toContain('Our counter-offer · 15 Dec')
    expect(en).toContain('Their words: “Yes, 15 December works for us.”')
    expect(en).toContain('The customer said yes to our counter-offer')
  })

  it('a reader whose team does not answer the kind: held, and the window says who answers', () => {
    const en = windowOf(draw('f-pr-08-team'))
    expect(en).toContain('Sales answers changes, cancels and ship what is ready.')
    expect(en).not.toContain('Words the customer reads')
  })

  it('an answer the API refused reads in our words (never its English message)', () => {
    expect(windowOf(draw('f-pr-08-refused'))).toContain('The order has no open work order yet: nothing to pause.')
    expect(windowOf(draw('f-pr-08-refused', 'it'))).toContain('L’ordine non ha ancora ordini di lavoro aperti')
  })

  it('PW-H01b: another customer’s request opens "not there any more" — no customer, no order, no request of it named', () => {
    for (const locale of LOCALES) {
      const shown = windowOf(draw('f-pr-08-not-found', locale))
      expect(shown, locale).toContain(locale === 'en' ? 'This request is not there any more.' : 'Questa richiesta non c’è più.')
      expect(shown, locale).not.toMatch(/Brand Alpha|Brand Beta|SO-DEMO|PO-ALPHA/)
      expect(shown, locale).not.toMatch(/Accept|Accetta|Refuse|Rifiuta/)
    }
  })

  it('Suggest something else: a date from today, a fee for a price reader, our words, and what the customer reads', () => {
    const html = draw('f-pr-08-counter')
    const dialog = windowOf(html, 'data-modal=""')
    for (const word of ['Suggest something else · SO-DEMO-0101', 'The date we offer', 'A fee', 'Our words to the customer', 'Send the counter-offer']) expect(dialog).toContain(word)
    expect(dialog).toContain('The customer reads: our counter-offer')
  })
})

describe('a customer’s batch: one window, Accept all re-checked, or each order alone (L26, PW-12)', () => {
  it('Cancel · 6 orders of one customer: each order with its state and Answer alone (the withdrawn one none), Accept all 5', () => {
    const en = windowOf(draw('f-pr-08-batch'))
    expect(en).toContain('Cancel · 6 orders')
    expect(en).toContain('5 of 6 waiting')
    expect(en.match(/Answer alone/g)?.length).toBe(5)
    for (const word of ['Accept all 5', 'Refuse all 5']) expect(en).toContain(word)
    expect(en).toContain('Brand Alpha asked this of 6 orders at once')
    expect(en).not.toMatch(/Brand Beta/)
    expect(windowOf(draw('f-pr-08-batch', 'it'))).toContain('Annullamento · 6 ordini')
  })

  it('Accept all lists the current ones "Waiting → Accepted", the one withdrawn meanwhile left out with why; done says each', () => {
    const review = windowOf(draw('f-pr-08-batch-accept'), 'data-review=""')
    expect(review).toContain('Accept 5 · Cancel')
    expect(review.match(/Waiting → Accepted/g)?.length).toBe(5)
    expect(review).toContain('Left out (1)')
    expect(review).toContain('The customer withdrew this request.')
    const done = windowOf(draw('f-pr-08-batch-done'), 'data-review=""')
    expect(done).toContain('Cancelled: nothing more is made or shipped.')
    expect(done).toContain('A shipment is being prepared for the order’s address')
  })
})

describe('after an accept: "Lift the hold" / "Clear rush" instead of a generic undo (R-23)', () => {
  it('the notice names the request in words and offers its follow-up; never "Undo"', () => {
    const lift = textOf(draw('f-pr-08-notice-lift'))
    expect(lift).toContain('Accepted: Pause: SO-DEMO-0102')
    expect(lift).toContain('Paused: WO-DEMO-0201.')
    expect(lift).toContain('Lift the hold')
    expect(lift).not.toMatch(/\bUndo\b/)
    const rush = textOf(draw('f-pr-08-notice-rush'))
    expect(rush).toContain('Accepted and rushed on the floor: Urgent – asked: SO-DEMO-0101')
    expect(rush).toContain('Clear rush')
    expect(textOf(draw('f-pr-08-notice-rush', 'it'))).toContain('Togli l’urgenza in reparto')
  })

  it('Lift the hold asks why (the office’s own line), naming the work orders it lifts on', () => {
    const dialog = windowOf(draw('f-pr-08-lift'), 'data-modal=""')
    expect(dialog).toContain('Lift the customer’s pause')
    expect(dialog).toContain('WO-DEMO-0201')
    expect(dialog).toContain('Why we lift it')
    expect(HOLD.kind).toBe('HOLD')
    expect(CANCEL.answeredIn).toBe('SALES')
  })
})

describe('the page wires the source, the window and the follow-ups', () => {
  it('Approvals reads the requests with no customer filter, opens an id no row names by asking, and mounts the window', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const page = readFileSync(fileURLToPath(new URL('../Approvals.tsx', import.meta.url)), 'utf8')
    expect(page).toContain('can.requests ? listWaitingRequests(api) : Promise.resolve(null)')
    expect(page).toContain('probeOpen(api, openId, { tasks: can.tasks, requests: can.requests })')
    expect(page).toContain("type.startsWith('order_change_request.')")
    const view = readFileSync(fileURLToPath(new URL('../view/InboxView.tsx', import.meta.url)), 'utf8')
    // F-SA-240: the window's own props — the inbox's rows are this door's list.
    expect(view).toContain('<RequestReview review={model.requestReview} grains={model.grains} offline={model.offline} busy={model.busy} nav={{ ids: reviewIds, onOpen: actions?.onOpen }} actions={actions?.request} />')
    expect(view).toContain('<FollowUpButton')
  })
})

// ---- F-SA-240 (sales page plan P5, P24; 14-change-flow §3.1, §3.5): ONE window, four doors ----------------------------------------
describe('F-SA-240: the review window opens from any door with its own props (one engine, more doors)', () => {
  const inboxOf = (id: string): InboxViewModel => (caseOf(id) as unknown as { depth: InboxViewModel }).depth
  const propsOf = (id: string, ids: readonly string[], onOpen?: (id: string | null) => void): RequestReviewProps => {
    const model = inboxOf(id)
    return { review: model.requestReview, grains: model.grains, offline: model.offline, busy: model.busy, nav: { ids, onOpen } }
  }
  /** Drawn with the shell's catalogue only: the window brings its own (approvals, approvals-depth, sales). */
  const alone = (props: RequestReviewProps, locale: Locale = 'en') => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(RequestReview, props)))
  const { RUSH, HOLD, CANCEL, BATCH } = REQUEST_FIXTURES

  it('Home › Approvals draws exactly the window it drew before: the same words, its arrows walking the inbox’s rows', () => {
    const go = () => undefined
    for (const id of ['f-pr-08-rush', 'f-pr-08-cancel', 'f-pr-08-agreed', 'f-pr-08-batch', 'f-pr-08-not-found']) {
      const model = inboxOf(id)
      const rows = (model.rows.items ?? []).map(openIdOf).filter((entry): entry is string => entry !== null)
      // The inbox (through InboxView, with a design case's absent actions: no arrows) and the window alone with the same props.
      expect(windowOf(alone(propsOf(id, rows))), id).toBe(windowOf(draw(id)))
      // With the inbox's actions, the arrows walk every row that opens a window here (tasks, quotes, requests, batches).
      const walked = windowOf(alone(propsOf(id, rows, go)))
      if (rows.includes(model.requestReview!.id)) expect(walked, id).toContain(`${rows.indexOf(model.requestReview!.id) + 1} of ${rows.length}`)
    }
  })

  it('mounted by another door with its own list: the arrows walk that list only; one request alone has none', () => {
    const go = () => undefined
    const order = [RUSH.id, HOLD.id, CANCEL.id]
    expect(windowOf(alone(propsOf('f-pr-08-rush', order, go)))).toContain('1 of 3')
    expect(windowOf(alone(propsOf('f-pr-08-cancel', order, go)))).toContain('3 of 3')
    expect(windowOf(alone(propsOf('f-pr-08-rush', [RUSH.id], go)))).not.toMatch(/\d of \d/)
    // An id its door does not list (a link from the bell): the window opens, without arrows.
    expect(windowOf(alone(propsOf('f-pr-08-refused', [RUSH.id, CANCEL.id], go)))).not.toMatch(/\d of \d/)
  })

  it('it brings its own words: drawn on a page with the shell’s catalogue only, in both languages, no key left', () => {
    for (const locale of LOCALES) {
      for (const id of ['f-pr-08-rush', 'f-pr-08-cancel', 'f-pr-08-counter', 'f-pr-08-batch', 'f-pr-08-batch-accept', 'f-pr-08-refused', 'f-pr-08-not-found']) {
        const html = alone(propsOf(id, []), locale)
        expect(html.length, id).toBeGreaterThan(200)
        expect(leftKeys(html, PREFIXES), `${id} (${locale})`).toEqual([])
      }
    }
    expect(windowOf(alone(propsOf('f-pr-08-rush', []), 'it'))).toContain('Accetta e segna urgente in reparto')
  })

  it('the door’s parts: the window with Lift the hold’s why, and the notice after an answer with its follow-up (never "Undo")', () => {
    const model = inboxOf('f-pr-08-rush')
    const followUp = { kind: 'lift' as const, requestId: HOLD.id, workOrders: [{ id: 'wo-1', number: 'WO-DEMO-0201' }] }
    const door: RequestDoorParts = {
      window: { review: model.requestReview, grains: model.grains, offline: false, busy: false, nav: { ids: [RUSH.id] } },
      notice: { key: 'notice.requestAccepted', tone: 'success', request: { kindLabel: { en: 'Pause', it: 'Pausa' }, record: { type: 'SalesOrder', id: HOLD.orderId, label: HOLD.orderNumber } }, lines: [{ en: 'Paused: WO-DEMO-0201.', it: 'In pausa: WO-DEMO-0201.' }], followUp },
      lift: { followUp, busy: false, problem: null },
      can: { lift: true, rush: true },
      actions: { onDismiss: () => undefined },
    }
    const html = render(createElement(RequestDoorWindow, { door }))
    expect(windowOf(html)).toContain('Urgent – asked · SO-DEMO-0101')
    const dialog = windowOf(html, 'data-modal=""')
    expect(dialog).toContain('Lift the customer’s pause')
    expect(dialog).toContain('WO-DEMO-0201')
    const notice = textOf(render(createElement(RequestDoorNoticeBanner, { door })))
    expect(notice).toContain('Accepted: Pause: SO-DEMO-0102')
    expect(notice).toContain('Paused: WO-DEMO-0201.')
    expect(notice).toContain('Lift the hold')
    expect(notice).not.toMatch(/\bUndo\b/)
    // Without the right to lift: the follow-up is held with why, never hidden.
    const held = render(createElement(RequestDoorNoticeBanner, { door: { ...door, can: { lift: false, rush: true } } }))
    expect(held).toContain('aria-disabled="true"')
    expect(held).toContain('Lift the hold')
    expect(textOf(render(createElement(RequestDoorNoticeBanner, { door: { ...door, notice: null } })))).toBe('')
  })

  it('a door’s list: the requests waiting for this reader, a customer’s batch of 2+ as one entry; what an id opens', () => {
    const { BATCH_ROWS } = REQUEST_FIXTURES
    const list = doorListOf([RUSH, HOLD, ...BATCH_ROWS])
    // Oldest first, as the inbox lists them.
    expect(list.ids).toEqual([RUSH.id, HOLD.id, BATCH])
    expect(list.ids).not.toContain(BATCH_ROWS[0]!.id)
    expect(list.batches).toEqual([BATCH])
    expect(doorTargetOf(list, BATCH)).toBe('batch')
    expect(doorTargetOf(list, RUSH.id)).toBe('request')
    // A request of the batch, or an id the door does not list: asked of the API (null here).
    expect(doorTargetOf(list, BATCH_ROWS[0]!.id)).toBeNull()
    expect(doorTargetOf(list, 'another')).toBeNull()
    // Answered or withdrawn requests are not the door's to walk.
    expect(doorListOf([{ ...RUSH, status: 'ACCEPTED', waitingOn: null }]).ids).toEqual([])
  })

  it('the address: ?open=<id> on the door’s own page, every other word kept (Esc / Close returns to the same tab)', () => {
    expect(doorAddress('tab=changes', 'r-1')).toBe('?tab=changes&open=r-1')
    expect(doorAddress('?tab=changes&open=r-1', null)).toBe('?tab=changes')
    expect(doorAddress('tab=work&open=r-1&thread=open', 'r-2')).toBe('?tab=work&open=r-2&thread=open')
    expect(doorAddress('open=r-1', null)).toBe('')
    expect(doorAddress('', 'b 1')).toBe('?open=b+1')
  })

  it('sa-5’s refusals in words: a colourway held once CUT, an accept that leaves extra pieces needs their outcome', () => {
    expect(KNOWN_REQUEST_REFUSALS.has('COLOUR_CUT')).toBe(true)
    expect(KNOWN_REQUEST_REFUSALS.has('EXTRA_OUTCOME')).toBe(true)
    expect(KNOWN_REQUEST_REFUSALS.has('COLOUR_IN_WORK')).toBe(false)
    const refused = (path: string) => new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path, message: 'x' }])
    expect(answerProblem(refused('request/COLOUR_CUT'))).toEqual({ key: 'customerRequest.refusal.COLOUR_CUT', reload: true })
    expect(answerProblem(refused('refusal/EXTRA_OUTCOME'))).toEqual({ key: 'customerRequest.refusal.EXTRA_OUTCOME', reload: true })
    const said = textOf(alone({ ...propsOf('f-pr-08-rush', []), review: { ...inboxOf('f-pr-08-rush').requestReview!, problem: 'customerRequest.refusal.EXTRA_OUTCOME' } }))
    expect(said).toContain('choose what happens to the extra pieces first')
    const it_ = textOf(alone({ ...propsOf('f-pr-08-rush', []), review: { ...inboxOf('f-pr-08-rush').requestReview!, problem: 'customerRequest.refusal.COLOUR_CUT' } }, 'it'))
    expect(it_).toContain('un pezzo tagliato non cambia colore')
  })

  it('the code: RequestReview takes no inbox model; the door hook reads through use-request-review and keeps the page’s address', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const window = readFileSync(fileURLToPath(new URL('./view/RequestReview.tsx', import.meta.url)), 'utf8')
    expect(window).not.toMatch(/InboxViewModel|InboxActions|model\.rows/)
    const hook = readFileSync(fileURLToPath(new URL('./use-request-review-door.ts', import.meta.url)), 'utf8')
    expect(hook).toContain('useRequestReview({')
    expect(hook).toContain('probeOpen(api, openId, { tasks: false, requests: true })')
    expect(hook).toContain('router.replace(hrefOf(id), { scroll: false })')
    expect(hook).toContain('nav: { ids: door.ids, onOpen: open }')
  })
})
