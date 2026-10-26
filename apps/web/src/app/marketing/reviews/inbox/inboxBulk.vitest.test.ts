import { describe, expect, it } from 'vitest'
import {
  BULK_ACTIONS, BULK_LABEL, bulkActionHeld, bulkApplyHeld, bulkApplyLabel, bulkBody, bulkReach, bulkResultWords, bulkSkipWords,
  manageHeld, ownerChoices, type BulkRow,
} from './inboxBulk'

const NOW = new Date('2026-10-26T12:00:00Z')

const row = (id: string, over: Partial<BulkRow> = {}): BulkRow => ({
  id, channel: 'EBAY', market: 'DE', kind: 'seller', postedAt: '2026-10-25T12:00:00Z', imported: false, status: 'NEW', assignee: null,
  responses: { sent: 0, draft: 0 }, ...over,
})

describe('Inbox bulk bar', () => {
  it('offers Assign, Tag, Set status and Draft with AI', () => {
    expect(BULK_ACTIONS.map((a) => BULK_LABEL[a])).toEqual(['Assign', 'Tag', 'Set status', 'Draft with AI'])
  })

  it('holds every action with its reason: permission first, then nothing ticked, then too many', () => {
    expect(bulkActionHeld('assign', { canManage: false, rows: [row('a')] })).toBe("You need 'Manage reviews' to assign reviews.")
    expect(manageHeld('draft')).toBe("You need 'Manage reviews' to draft replies.")
    expect(bulkActionHeld('tag', { canManage: true, rows: [] })).toBe('Tick at least one review.')
    const many = Array.from({ length: 201 }, (_, i) => row(`r${i}`))
    expect(bulkActionHeld('status', { canManage: true, rows: many })).toBe('Pick at most 200 reviews at once. Untick 1.')
    expect(bulkActionHeld('draft', { canManage: true, rows: many.slice(0, 51), now: NOW })).toBe('Draft with AI takes at most 50 reviews at once. Untick 1.')
    expect(bulkActionHeld('status', { canManage: true, rows: [row('a')] })).toBeNull()
  })

  it('counts the rows an action changes and names why it skips the others', () => {
    const rows = [row('a', { status: 'RESOLVED' }), row('b'), row('c', { assignee: 'owner-a' })]
    expect(bulkReach('status', 'RESOLVED', rows, NOW)).toEqual({ apply: ['b', 'c'], skipped: [{ id: 'a', reason: 'Already Resolved.' }] })
    expect(bulkReach('assign', 'owner-a', rows, NOW).skipped).toEqual([{ id: 'c', reason: 'Already assigned to owner-a.' }])
    expect(bulkReach('assign', null, rows, NOW).skipped.map((s) => s.reason)).toEqual(['Nobody is assigned already.', 'Nobody is assigned already.'])
    expect(bulkApplyLabel('status', 'RESOLVED', 2)).toBe('Set 2 reviews to Resolved')
    expect(bulkApplyLabel('assign', 'owner-a', 1)).toBe('Assign 1 review to owner-a')
    expect(bulkApplyLabel('assign', null, 3)).toBe('Unassign 3 reviews')
    expect(bulkApplyLabel('draft', null, 4)).toBe('Draft 4 replies with AI')
  })

  it('a draft follows the reply rules: never where a reply went out or a draft waits', () => {
    const rows = [row('sent', { responses: { sent: 1, draft: 0 } }), row('draft', { responses: { sent: 0, draft: 1 } }), row('ok')]
    const reach = bulkReach('draft', null, rows, NOW)
    expect(reach.apply).toEqual(['ok'])
    expect(reach.skipped[0].reason).toMatch(/already has a reply/)
    expect(reach.skipped[1].reason).toBe('A reply draft is already saved.')
    const none = bulkActionHeld('draft', { canManage: true, rows: rows.slice(0, 2), now: NOW })
    expect(none).toMatch(/^None of the ticked reviews can get a draft: /)
  })

  it('holds Apply until the value is right, and when it would change nothing', () => {
    const ctx = { canManage: true, rows: [row('a', { status: 'RESOLVED' })], now: NOW }
    expect(bulkApplyHeld('tag', '  ', ctx)).toBe('Type a tag first.')
    expect(bulkApplyHeld('tag', 'x'.repeat(41), ctx)).toBe('A tag is at most 40 characters.')
    expect(bulkApplyHeld('status', null, ctx)).toBe('Pick a status first.')
    expect(bulkApplyHeld('status', 'RESOLVED', ctx)).toBe('Nothing to change: Already Resolved.')
    expect(bulkApplyHeld('status', 'IGNORED', ctx)).toBeNull()
    expect(bulkApplyHeld('assign', '', ctx)).toBe('Nothing to change: Nobody is assigned already.')
  })

  it('words the server answer, skipped rows grouped by reason', () => {
    expect(bulkSkipWords([])).toBeNull()
    expect(bulkSkipWords([{ reason: 'Already Resolved.' }, { reason: 'Already Resolved.' }])).toBe('2 ticked reviews stay as they are: 2 × Already Resolved.')
    expect(bulkResultWords('status', 'RESOLVED', { changed: 9, skipped: [{ reason: 'Already Resolved.' }] }))
      .toBe('Set 9 reviews to Resolved. 1 ticked review stays as it is: 1 × Already Resolved.')
    expect(bulkResultWords('draft', null, { changed: 1, skipped: [] })).toBe('Drafted a reply with AI. Nothing was sent: each draft waits for a person.')
    expect(bulkResultWords('tag', 'size chart', { changed: 0, skipped: [] })).toBe('Nothing changed.')
  })

  it('sends each id once; a draft carries no value', () => {
    expect(bulkBody(['a', 'a', 'b'], 'tag', ' size chart ')).toEqual({ ids: ['a', 'b'], action: 'tag', value: 'size chart' })
    expect(bulkBody(['a'], 'draft', 'x')).toEqual({ ids: ['a'], action: 'draft', value: null })
    expect(bulkBody(['a'], 'assign', '')).toEqual({ ids: ['a'], action: 'assign', value: null })
  })

  it('the Assign window offers nobody, me and the current owners', () => {
    expect(ownerChoices(['owner-a', 'owner-b', 'owner-a'], 'owner-b')).toEqual([
      { value: '', label: 'Nobody' }, { value: 'owner-b', label: 'owner-b (you)' }, { value: 'owner-a', label: 'owner-a' },
    ])
  })
})
