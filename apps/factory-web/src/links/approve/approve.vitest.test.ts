import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import { linkTaskOf } from '../_nav/link-types'
import { approvalPageSchema } from './api'
import { designScreen } from './fixtures'
import { answerProblem, answerRefusal, commentNeeded, decidedTone, decisionsOf, filesInOrder, isDecided, linePrices, markable, markSaveHeld, markupBodyOf, netMoved, panelOf, readRefusal, signLabelKey, sizeMoves } from './model'
import { approvalsHome, mailKeyFromFragment, officeAddress, signInFieldProblems, signInProblemOf } from './office/model'
import { designScreen as officeScreen } from './office/fixtures'

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/link-approve.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))

describe('SCR-198 Approve — the link page', () => {
  it('an APPROVAL link of a request opens this page (link-type registry)', () => {
    expect(linkTaskOf({ purpose: 'APPROVAL', record: { type: 'ApprovalRequest' } })).toBe('approve')
  })

  it('each kind has its panel; a revised order and a signature never offer "approve with changes"', () => {
    expect(panelOf('REVISED_ORDER')).toBe('revised-order')
    expect(panelOf('PROOF')).toBe('proof')
    expect(panelOf('CONCESSION')).toBe('concession')
    expect(panelOf('SIGNATURE')).toBe('signature')
    for (const kind of ['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK'] as const) expect(panelOf(kind)).toBe('sample')
    expect(decisionsOf({ may: { answer: true, withChanges: true, held: null } })).toEqual(['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'])
    expect(decisionsOf({ may: { answer: true, withChanges: false, held: null } })).toEqual(['APPROVED', 'REFUSED'])
  })

  it('the answer is checked first in order: a choice, then words for changes and for a refusal', () => {
    expect(answerProblem(null, '')).toEqual({ key: 'decision.problem.choose', field: 'decision' })
    expect(answerProblem('REFUSED', '   ')).toEqual({ key: 'decision.problem.why', field: 'comment' })
    expect(answerProblem('APPROVED_WITH_CHANGES', '')).toEqual({ key: 'decision.problem.what', field: 'comment' })
    expect(answerProblem('APPROVED', '')).toBeNull()
    expect(answerProblem('APPROVED', 'x'.repeat(4001))).toEqual({ key: 'decision.problem.long', field: 'comment' })
    expect(commentNeeded('APPROVED')).toBe(false)
    expect(commentNeeded('REFUSED')).toBe(true)
    expect(signLabelKey(null)).toBe('sign.choose')
    expect(signLabelKey('REFUSED')).toBe('sign.go.REFUSED')
  })

  it('a photo or a PDF page may be marked; the marks go as an overlay (none: no markup), a note trimmed', () => {
    expect(markable({ contentType: 'image/jpeg' })).toBe('picture')
    expect(markable({ contentType: 'application/pdf' })).toBe('pdf')
    expect(markable({ contentType: 'text/csv' })).toBeNull()
    expect(markSaveHeld([])).toBe('mark.held.none')
    expect(markupBodyOf(null)).toBeNull()
    expect(markupBodyOf({ fileId: 'f', page: null, marks: [], note: 'x' })).toBeNull()
    expect(markupBodyOf({ fileId: 'f', page: 2, marks: [{ kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.1 }], note: '  qui  ' })).toEqual({ fileId: 'f', page: 2, shapes: [{ kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.1 }], note: 'qui' })
    expect(filesInOrder([{ id: 'p', originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 }, { id: 'i', originalName: 'b.png', contentType: 'image/png', sizeBytes: 1 }]).map((file) => file.id)).toEqual(['i', 'p'])
  })

  it('a refused answer says what it means: gone (the link’s one use), the wrong person, changed (read again), the name', () => {
    expect(answerRefusal(new ApiError('not_found', 404, 'not_found', 'x'))).toEqual({ key: 'problem.gone', link: 'unavailable' })
    expect(answerRefusal(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.wrongPerson', link: 'wrong_person' })
    expect(answerRefusal(new ApiError('conflict', 409, 'invalid_state', 'x'))).toEqual({ key: 'problem.changed', reload: true })
    expect(answerRefusal(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/typedName' }])).key).toBe('problem.name')
    expect(answerRefusal(new Error('boom')).key).toBe('problem.internal')
    expect(readRefusal(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('unavailable')
    expect(readRefusal(new ApiError('unavailable', 503, 'x', 'x'))).toBe('error')
  })

  it('the revised order: only the sizes that moved, the line’s prices, and whether the net value moved', () => {
    const page = designScreen.cases.find((item) => item.id === 'revised-order')!.model.page!
    const order = page.content.revisedOrder!
    expect(sizeMoves(order.lines[0]!)).toEqual([{ size: 'M', before: 8, after: 14 }])
    expect(linePrices(order, order.lines[2]!.lineId)?.unitPrice).toEqual({ before: null, after: '210.00' })
    expect(netMoved(order)).toBe(true)
    expect(netMoved({ ...order, netAmountAfter: order.netAmountBefore })).toBe(false)
    expect(netMoved({ ...order, netAmountBefore: undefined })).toBe(false)
  })

  it('the end is the API’s decided words; its tone follows the answer', () => {
    const decided = designScreen.cases.find((item) => item.id === 'decided')!.model.page!
    expect(isDecided(decided)).toBe(true)
    expect(isDecided(designScreen.cases.find((item) => item.id === 'sample')!.model.page)).toBe(false)
    expect(decidedTone('APPROVED')).toBe('success')
    expect(decidedTone('REFUSED')).toBe('warning')
  })

  it('every made-up page parses as the API answers it, and the design cases cover the states', () => {
    for (const item of designScreen.cases) if (item.model.page) expect(() => approvalPageSchema.parse(item.model.page), item.id).not.toThrow()
    const ids = designScreen.cases.map((item) => item.id)
    for (const state of ['loading', 'error', 'gone', 'wrong-person', 'held', 'decided', 'mark-photo', 'revised-order', 'proof', 'concession', 'sample']) expect(ids).toContain(state)
  })

  it('both catalogues have the same keys and placeholders', () => {
    const it = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(en)) expect(holes(it[key]!), key).toEqual(holes(en[key]!))
  })
})

describe('SCR-198-office — an office approval opened from its e-mail (PLT-089)', () => {
  const KEY = `am1.${'0190f0e2-0000-7000-8000-000000000001'}.${'0190f0e2-0000-7000-8000-000000000002'}.${'0190f0e2-0000-7000-8000-000000000003'}.${'a'.repeat(43)}`

  it('takes the key from the fragment only when it is one', () => {
    expect(mailKeyFromFragment(`#key=${encodeURIComponent(KEY)}`)).toBe(KEY)
    expect(mailKeyFromFragment('#key=am1.nope')).toBeNull()
    expect(mailKeyFromFragment('')).toBeNull()
  })

  it('opens the approval where the notification points, in its own company', () => {
    const companies = [
      { id: 'c1', code: 'DEMO' },
      { id: 'c2', code: 'ALTRA' },
    ]
    expect(officeAddress({ record: { type: 'Quote', id: 'q', label: 'Q-1' }, companyId: 'c2', anchor: 'approval:a1' }, companies, companies[0]!)).toBe('/w/ALTRA/home/approvals?open=a1')
    expect(officeAddress({ record: { type: 'Quote', id: 'q', label: 'Q-1' }, companyId: 'c1', anchor: null }, companies, null)).toBe('/w/DEMO/sales/quotes/q')
    expect(officeAddress({ record: { type: 'Task', id: 't', label: 'T' }, companyId: null, anchor: 'task:t' }, [], { code: 'DEMO' })).toBe('/w/DEMO/home/tasks?open=t')
    expect(officeAddress({ record: { type: 'Quote', id: 'q', label: 'Q' }, companyId: null, anchor: null }, [], null)).toBeNull()
    expect(approvalsHome({ code: 'DEMO' })).toBe('/w/DEMO/home/approvals')
  })

  it('never says which part of a sign-in was wrong; the form checks its fields first', () => {
    expect(signInProblemOf({ kind: 'signed_out' }, 'password')).toBe('wrongCredentials')
    expect(signInProblemOf({ kind: 'signed_out' }, 'code')).toBe('wrongCode')
    expect(signInProblemOf({ kind: 'forbidden' }, 'password')).toBe('suspended')
    expect(signInFieldProblems({ company: '', email: 'x', password: '' })).toEqual({ company: 'office.field.company', email: 'office.field.email', password: 'office.field.password' })
    expect(signInFieldProblems({ company: 'demo', email: 'anna@example.com', password: 'p' })).toEqual({})
  })

  it('the design cases cover every step and end', () => {
    const ids = officeScreen.cases.map((item) => item.id)
    for (const state of ['sign-in', 'code', 'opening', 'open', 'decided', 'not-valid', 'missing', 'error']) expect(ids).toContain(state)
  })
})
