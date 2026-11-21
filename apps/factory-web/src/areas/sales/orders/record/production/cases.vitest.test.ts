import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { designScreen } from '../fixtures'

// T.1 (order PRODUCTION tab): the design cases of the states the seed lacks — each says what it shows, in the words the tab uses.

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so a dialog's words are checked.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => {
  const found = designScreen.cases.find((item) => item.id === id)
  expect(found, id).toBeDefined()
  return renderView(view, found!.model, locale)
}
const text = (id: string, locale: 'it' | 'en' = 'en') => textOf(draw(id, locale))

describe('T.1: the Production tab’s states, by role', () => {
  it('F-SC-W3: Production now\'s stage bar — a Planner\'s steps are real buttons (named, 44 px); Sales reads words and one held line; Read-only neither', () => {
    const now = (id: string) => {
      const html = draw(id)
      return html.slice(html.indexOf('id="now"'), html.indexOf('</section>', html.indexOf('id="now"')))
    }
    const planner = now('f-sc-production-steps')
    const bar = planner.slice(planner.indexOf('class="fw-pt-segs"'), planner.indexOf('</ol>', planner.indexOf('class="fw-pt-segs"')))
    expect(bar.match(/<button type="button" class="fw-pt-seg-go"/g)?.length).toBe(4)
    for (const stage of ['Preparing', 'Cutting', 'Quality check', 'Ready to ship']) expect(bar, stage).toContain(`aria-label="Set the stage of SO-2026-0088 to ${stage}…"`)
    // The current step (what the customer reads) stays words, never a button.
    expect(bar).toMatch(/<li class="fw-pt-seg is-current" aria-current="step"><span class="fw-pt-seg-bar"/)
    expect(planner).not.toContain('Production does this — a planner or the production manager')
    const sales = now('f-sc-production-held')
    expect(sales).not.toContain('fw-pt-seg-go')
    expect(sales).toContain('Production does this — a planner or the production manager')
    // The hint to the hand row on Overview stays.
    expect(textOf(sales)).toContain('Set by hand')
    expect(now('pt-read-only')).not.toContain('fw-pt-seg-go')
    expect(now('pt-read-only')).not.toContain('Production does this')
  })

  it('F-SC-W2: a step of Production now\'s stage bar opens the SAME stage dialog as Overview (mounted once for the page), on that step', () => {
    const html = draw('f-ms-dialog-production')
    expect(html.match(/role="dialog"/g)?.length).toBe(1)
    expect(textOf(html)).toContain('Set the stage of SO-2026-0088 by hand')
    expect(html).toMatch(/<input type="radio"[^>]*value="QUALITY"[^>]*checked=""|<input type="radio"[^>]*checked=""[^>]*value="QUALITY"/)
    expect(textOf(html)).toContain("It clears by itself once the floor's counts reach Quality check.")
  })

  it('holds: the three strips and the office’s note for the Owner; Sales sees no hold door and one line says who does it (D2)', () => {
    const owner = text('pt-holds-owner')
    // The customer's pause is one strip in the office's own words (where.strip.pause), never the customer's headline words.
    const pause = createTranslator('en', messagesFor('en', ['orders']).orders!)('where.strip.pause')
    for (const words of ['Production hold — the lining roll is short', pause, 'Shade difference on the leather', 'Made-up: rotolo di fodera in arrivo giovedì.']) expect(owner, words).toContain(words)
    expect(owner).not.toContain('Paused at your request')
    const sales = text('pt-holds-sales')
    expect(sales).not.toContain('Lift the hold…')
    expect(sales).not.toContain('Release on Quality ›')
    expect(sales).toContain('Production does this — a planner or the production manager')
  })

  it('asks: open, escalated (late), answered by a reply on a batch (L8); the customer’s problem with Reply in the thread', () => {
    expect(text('pt-asks-open')).toContain('Ask for an update')
    const escalated = text('pt-asks-escalated')
    for (const words of ['Escalated 1× — now with the backup', 'late']) expect(escalated, words).toContain(words)
    const answered = text('pt-asks-answered')
    for (const words of ['Latest update', 'Bea Esempio', 'Made-up: cutting is done', 'Answered for SO-2026-0090 and 1 more']) expect(answered, words).toContain(words)
    const problem = text('pt-customer-problem')
    for (const words of ['Reported by the customer', 'Reply in the thread']) expect(problem, words).toContain(words)
  })

  it('the promise set then moved twice: the history counts two moves, the first promise is “Date set”, the line moved from its own day', () => {
    const moves = text('pt-promise-moves')
    expect(moves).toContain('Date set')
    expect(moves).toContain('Show 1 earlier move')
  })

  it('gates: late, waiting on the customer’s sample (Decide for the customer…), started before', () => {
    const gates = text('pt-gates-planner')
    expect(gates).toMatch(/Decide for .+…/)
    expect(gates).toContain('late')
  })

  it('What we make it to: a replaced pattern with its change note and the work order’s decision; no inquiry said in one line', () => {
    const replaced = text('pt-specs-replaced')
    for (const words of ['Pattern v3 · replaced by v4', 'v4 changed: Made-up: the knee pad pocket 2 cm lower.', 'ECO-2026-0004', 'finish on v3']) expect(replaced, words).toContain(words)
    expect(text('pt-specs-no-pack')).toContain('No customer tech pack on this order.')
  })

  it('Materials: missing, partly, all here; the receipt dialog says the leather by the hide; what we buy short, then asked', () => {
    expect(text('pt-goods-missing')).toContain('Record what arrived…')
    expect(text('pt-goods-partly')).toContain('still to come (2 of 6 pz arrived)')
    expect(text('pt-goods-all-here')).toContain('Everything is here for the work orders made so far')
    const receipt = text('pt-receipt')
    for (const words of ['Record what the customer sent ·', 'Leather received hide by hide goes through a purchase receipt.', 'Record the receipt']) expect(receipt, words).toContain(words)
    const short = text('pt-buy-short')
    for (const words of ['Zip 60 cm · Navy', 'Open PO-2026-0091', 'Ask the buyers…']) expect(short, words).toContain(words)
    expect(text('pt-buy-asked')).toContain('Asked 20/11/2026')
    expect(text('pt-warehouse')).toContain('Record what the customer sent…')
  })

  it('Finance and Read-only: the tab read, no act (L7); Read-only never reads a price', () => {
    for (const id of ['pt-finance', 'pt-read-only']) {
      const words = text(id)
      for (const act of ['Ask for an update', 'Lift the hold…', 'Record what the customer sent…', 'Make work orders']) expect(words, `${id} ${act}`).not.toContain(act)
    }
    expect(text('pt-read-only')).not.toContain('€')
  })

  it('every new case draws in Italian too', () => {
    for (const item of designScreen.cases.filter((entry) => entry.id.startsWith('pt-'))) expect(text(item.id, 'it').length, item.id).toBeGreaterThan(200)
  })
})
