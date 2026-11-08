import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import { recordRequestsSchema } from './api'
import { designScreen } from './fixtures'
import { askDraftProblems, askedNotice, askFilesOf, askHeld, askRefusal, defaultDueAt, newDraft, openCount, statusTone, takesApprovals, withdrawHeld, withdrawRefusal } from './model'

const NOW = Date.parse('2026-11-10T09:00:00.000Z')
const DAY = 86_400_000
const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/record-approvals.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))

describe('record panels › Approvals (ask a partner to approve)', () => {
  it('only a record an approval names has the tab', () => {
    for (const type of ['Style', 'Quote', 'SalesOrder', 'PurchaseOrder', 'SubcontractOrder', 'NcrConcession', 'SalesOrderAmendment', 'SalesOrderLine', 'RiskAssessmentVersion']) expect(takesApprovals(type), type).toBe(true)
    expect(takesApprovals('WorkOrder')).toBe(false)
  })

  it('a fresh draft takes the first kind, its default due time and the partner’s first address', () => {
    const draft = newDraft(['PROOF'], NOW, ['anna@example.com'])
    expect(draft).toMatchObject({ kind: 'PROOF', send: true, email: 'anna@example.com', fileIds: [], question: '' })
    expect(Date.parse(draft.dueAt) - NOW).toBeGreaterThan(4 * DAY)
    expect(Date.parse(defaultDueAt('SIGNATURE', NOW)) - NOW).toBeGreaterThan(13 * DAY)
  })

  it('the dialog checks its fields as the API does: words, due between an hour and the kind’s limit, files where needed, an address to mail', () => {
    const ok = { kind: 'SAMPLE' as const, question: 'Va bene?', dueAt: new Date(NOW + 2 * DAY).toISOString(), fileIds: ['f'], send: true, email: 'a@b.example', language: '' as const }
    expect(askDraftProblems(ok, NOW)).toEqual({})
    expect(askDraftProblems({ ...ok, question: ' ', fileIds: [], email: 'x' }, NOW)).toEqual({ question: 'ask.problem.question', fileIds: 'ask.problem.files', email: 'ask.problem.email' })
    expect(askDraftProblems({ ...ok, dueAt: new Date(NOW + 10 * 60_000).toISOString() }, NOW).dueAt).toBe('ask.problem.dueSoon')
    expect(askDraftProblems({ ...ok, dueAt: new Date(NOW + 61 * DAY).toISOString() }, NOW).dueAt).toBe('ask.problem.dueLate')
    // A concession needs no file; a link to pass on needs no address.
    expect(askDraftProblems({ ...ok, kind: 'CONCESSION', fileIds: [], send: false, email: '' }, NOW)).toEqual({})
  })

  it('Ask is held with its reason: no right, the record’s own words, nothing to ask', () => {
    const read = { status: 'ready' as const, kinds: ['SAMPLE' as const], held: null, requests: [] }
    expect(askHeld({ can: { ask: false }, read })).toEqual({ key: 'held.noRight' })
    expect(askHeld({ can: { ask: true }, read: { ...read, held: 'Annullato.' } })).toEqual({ words: 'Annullato.' })
    expect(askHeld({ can: { ask: true }, read: { ...read, kinds: [] } })).toEqual({ key: 'held.noKind' })
    expect(askHeld({ can: { ask: true }, read })).toBeNull()
    expect(withdrawHeld({ may: { withdraw: true }, status: 'OPEN' }, false)).toBe('held.noRight')
    expect(withdrawHeld({ may: { withdraw: false }, status: 'WITHDRAWN' }, true)).toBe('held.withdrawn')
  })

  it('the API’s refusals come back at their field, or in one line', () => {
    const invalid = new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/fileIds/0' }, { path: 'body/dueAt' }])
    expect(askRefusal(invalid)).toEqual({ problems: { fileIds: 'ask.problem.filesRefused', dueAt: 'ask.problem.dueRefused' }, problem: null })
    expect(askRefusal(new ApiError('conflict', 409, 'conflict', 'x')).problem).toBe('ask.problem.open')
    expect(askRefusal(new ApiError('conflict', 409, 'invalid_state', 'x')).problem).toBe('ask.problem.held')
    expect(askRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SUPPRESSED' }])).problems.email).toBe('ask.problem.suppressed')
    expect(withdrawRefusal(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('withdraw.problem.changed')
  })

  it('after an ask: the link once, a mail that failed, or mailed', () => {
    expect(askedNotice({ url: 'https://x.example/l#token=t', delivery: null })?.key).toBe('note.linkOnce')
    expect(askedNotice({ url: null, delivery: 'FAILED' })?.tone).toBe('warning')
    expect(askedNotice({ url: null, delivery: 'SENT' })?.key).toBe('note.mailed')
  })

  it('only current, available files may go; the tab counts what still waits', () => {
    expect(askFilesOf([{ id: 'a', name: 'a', contentType: 'image/png', status: 'AVAILABLE' }, { id: 'b', name: 'b', contentType: 'image/png', status: 'AVAILABLE', supersededAt: '2026-11-01T00:00:00Z' }, { id: 'c', name: 'c', contentType: 'image/png', status: 'QUARANTINED' }])?.map((file) => file.id)).toEqual(['a'])
    expect(askFilesOf(null)).toBeNull()
    const list = designScreen.cases.find((item) => item.id === 'list')!.model.approvals!
    expect(openCount(list)).toBe(1)
    expect(openCount({ read: { status: 'loading' } })).toBeNull()
    expect(statusTone('REFUSED')).toBe('danger')
  })

  it('the made-up requests parse as the API answers them; both catalogues match', () => {
    const read = designScreen.cases.find((item) => item.id === 'list')!.model.approvals!.read
    if (read.status !== 'ready') throw new Error('ready')
    expect(() => recordRequestsSchema.parse({ record: { type: 'SalesOrder', id: 'x', label: 'SO' }, kinds: read.kinds, held: null, requests: read.requests })).not.toThrow()
    const it = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(en)) expect(holes(it[key]!), key).toEqual(holes(en[key]!))
  })
})
