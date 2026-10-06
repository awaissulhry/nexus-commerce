/**
 * Approvals grid — the page's words and rules (queueWords.ts): status labels and tones, the "Where" words, the verbs
 * a row offers, the bulk buttons and why they are held, the health-strip tiles as filters, the phone columns, and the
 * poll's merge of pages. Pure: every time is passed in.
 */
import { describe, expect, it } from 'vitest'
import type { QueueCounts, QueueRow } from '@nexus/shared/approval-queue'
import {
  BULK_MAX,
  PHONE_COLUMNS,
  PLAN_TOOL_NAME,
  POLL_FAST_MS,
  POLL_IDLE_MS,
  ageText,
  appendPage,
  approveHeldWhy,
  approvedText,
  automateOffer,
  bulkApproveVerdict,
  bulkOutcomeText,
  bulkRejectVerdict,
  changeHidesLabel,
  codeSentence,
  countText,
  emptyWords,
  groupKey,
  isPhoneWidth,
  mergePolledPage,
  pollInterval,
  pollLimit,
  productText,
  requestSubline,
  rowMatchesSearch,
  rowMatchesTile,
  rowVerbIds,
  stateMeta,
  statusText,
  tileValue,
  whatSubline,
  whereText,
  whyText,
} from './queueWords'

const NOW = Date.parse('2026-10-05T12:00:00.000Z')

function row(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'a1',
    toolName: 'set-price',
    title: 'Set master price',
    area: 'pricing',
    state: 'waiting',
    rawStatus: 'pending',
    note: null,
    target: { kind: 'product', id: 'p1', sku: 'XR-GLOVE-M', name: 'Gale glove M', count: 1, href: '/products/p1/edit' },
    channel: null,
    market: null,
    changes: [{ label: 'Base price', from: '€50.00', to: '€52.00' }],
    changeCount: 1,
    summary: null,
    asker: { kind: 'claude', label: 'Claude · Ana', person: 'Ana', connection: 'Claude Desktop' },
    decider: null,
    reversibility: 'full',
    reachesOutside: true,
    nexusRecord: false,
    requestedAt: '2026-10-05T09:00:00.000Z',
    expiresAt: '2026-10-06T09:00:00.000Z',
    executeAfter: null,
    decidedAt: null,
    plan: null,
    canApprove: true,
    cannotApproveWhy: null,
    bulkApprovable: true,
    bulkBlockedWhy: null,
    automation: { level: 'ask', max: 'auto', whyWaits: 'Your rule for Set master price: Ask me' },
    ...over,
  }
}

const COUNTS: QueueCounts = {
  needsYou: 7, waiting: 6, backToYou: 1, starting: 1, running: 1, failed: 1, ranByRuleToday: 14,
  oldestNeedsYouAt: '2026-10-05T09:00:00.000Z',
}

describe('one status for the whole life of a request', () => {
  it('names each state with a tone; colour is never the only carrier (the label always says it)', () => {
    expect(stateMeta('waiting')).toEqual({ label: 'Waiting', tone: 'info' })
    expect(stateMeta('failed')).toEqual({ label: 'Failed', tone: 'danger' })
    expect(stateMeta('back_to_you')).toEqual({ label: 'Back to you', tone: 'warning' })
    expect(stateMeta('done').tone).toBe('success')
    expect(stateMeta('replaced').label).toBe('Replaced by an edit')
  })

  it('says when an approved request runs, when a held one runs, and how far a running plan is', () => {
    expect(statusText(row({ state: 'starting', executeAfter: new Date(NOW + 14_000).toISOString() }), NOW)).toBe('Runs in 14 s')
    expect(statusText(row({ state: 'on_hold', executeAfter: '2026-10-05T14:20:00.000Z' }), NOW, 'UTC')).toBe('On hold until 14:20')
    const plan = { steps: 120, byStatus: { done: 34, pending: 86 } }
    expect(statusText(row({ state: 'running', plan }), NOW)).toBe('Running · 34 of 120')
    expect(statusText(row({ state: 'running' }), NOW)).toBe('Running')
  })

  it('gives a plan its size, a running plan its progress, and a single request where it lands', () => {
    // What's second line says WHERE, so the Where column can stay hidden at desktop width.
    expect(whatSubline(row({ channel: 'EBAY', market: 'IT' }))).toBe('eBay IT')
    expect(whatSubline(row({ nexusRecord: true }))).toBe('Nexus')
    expect(whatSubline(row())).toBeNull() // reaches a channel it does not name: nothing guessed
    expect(whatSubline(row({ plan: { steps: 120, byStatus: {} } }))).toBe('Plan · 120 steps')
    expect(whatSubline(row({ state: 'running', plan: { steps: 120, byStatus: { done: 34, failed: 2 } } }))).toBe('34 of 120 done, 2 failed')
  })
})

describe('the row in words', () => {
  it('names one product by SKU and name, and many by their count', () => {
    expect(productText(row().target)).toBe('XR-GLOVE-M Gale glove M')
    expect(productText({ kind: 'product', id: null, sku: 'XR-1', name: null, count: 12, href: null })).toBe('12 products (first: XR-1)')
    expect(productText({ kind: 'campaign', id: null, sku: null, name: null, count: 3, href: null })).toBe('3 campaigns')
    expect(productText(null)).toBe('')
  })

  it('says where in plain words: "Nexus" when it never leaves Nexus or changes Nexus\'s own record; never a guessed channel', () => {
    expect(whereText({ channel: 'EBAY', market: 'it', reachesOutside: true, nexusRecord: false })).toBe('eBay IT')
    expect(whereText({ channel: 'AMAZON', market: null, reachesOutside: true, nexusRecord: false })).toBe('Amazon')
    expect(whereText({ channel: null, market: null, reachesOutside: false, nexusRecord: false })).toBe('Nexus')
    // A master price: made in Nexus, though the listings that follow it are sent on (as apply-content, which never leaves).
    expect(whereText({ channel: null, market: null, reachesOutside: true, nexusRecord: true })).toBe('Nexus')
    expect(whereText({ channel: null, market: null, reachesOutside: true, nexusRecord: false })).toBeNull()
  })

  it('shows the API note first, then why it waits under today\'s rule', () => {
    expect(whyText(row())).toBe('Your rule for Set master price: Ask me')
    expect(whyText(row({ note: 'Amazon: missing brand' }))).toBe('Amazon: missing brand')
    expect(whyText(row({ automation: { level: 'ask', max: 'ask', whyWaits: null } }))).toBeNull()
  })

  it('a finished request says its outcome AND who decided, once', () => {
    const ana = { kind: 'person' as const, label: 'Ana' }
    expect(whyText(row({ state: 'rejected', note: 'Rejected: too low', decider: ana }))).toBe('Rejected: too low · by Ana')
    expect(whyText(row({ state: 'rejected', note: 'Rejected by Ana', decider: ana }))).toBe('Rejected by Ana')
    expect(whyText(row({ state: 'done', note: 'Ran · approved by Ana', decider: ana }))).toBe('Ran · approved by Ana')
    expect(whyText(row({ state: 'done', note: '5 of 6 changes ran; 1 skipped.', decider: ana }))).toBe('5 of 6 changes ran; 1 skipped. · approved by Ana')
    expect(whyText(row({ state: 'done', note: 'Ran by your rule', decider: { kind: 'rule', label: 'Rule · Set master price' } }))).toBe('Ran by your rule')
    expect(whyText(row({ state: 'done', note: 'Ran', decider: { kind: 'claude-code', label: 'Ana, code in Claude' } }))).toBe('Ran · approved by Ana, code in Claude')
    // Nobody decided an expired request; a waiting one is not finished.
    expect(whyText(row({ state: 'expired', note: 'Nobody decided in time. Nothing changed.', decider: { kind: 'expiry', label: 'Expired' } }))).toBe('Nobody decided in time. Nothing changed.')
    expect(whyText(row({ decider: ana }))).toBe('Your rule for Set master price: Ask me')
  })

  it('one change line drops its label in the cell (What names it); several keep theirs', () => {
    expect(changeHidesLabel(row())).toBe(true)
    expect(changeHidesLabel(row({ changeCount: 3 }))).toBe(false)
    expect(changeHidesLabel(row({ changes: [{ label: 'A', from: '1', to: '2' }, { label: 'B', from: '1', to: '2' }], changeCount: 2 }))).toBe(false)
  })

  it('the search finds a row by any word it shows, in any case and order', () => {
    const r = row({ channel: 'EBAY', market: 'IT' })
    for (const hit of ['xr-glove-m', 'gale glove', 'Set master price', 'set-price', 'eBay IT', '€52.00', 'Ana', 'ask me', 'waiting', 'glove master']) {
      expect(rowMatchesSearch(r, hit), hit).toBe(true)
    }
    for (const miss of ['zzz-no-such-thing', 'glove helmet', 'Amazon']) expect(rowMatchesSearch(r, miss), miss).toBe(false)
    expect(rowMatchesSearch(r, '   ')).toBe(true)
  })

  it('counts age and the toolbar total plainly', () => {
    expect(ageText('2026-10-05T09:00:00.000Z', NOW)).toBe('3 h')
    expect(ageText(new Date(NOW - 20_000).toISOString(), NOW)).toBe('under a minute')
    expect(ageText(null, NOW)).toBeNull()
    expect(countText(100, 130, 'open')).toBe('Showing 100 of 130 open requests')
    expect(countText(1, 1, 'open')).toBe('1 open request')
    expect(countText(4, 4, 'done')).toBe('4 finished requests')
  })
})

describe('the verbs a row offers', () => {
  it('two verbs at most: Approve + Reject, Retry + Reject, or Undo', () => {
    expect(rowVerbIds('waiting')).toEqual(['approve', 'reject'])
    expect(rowVerbIds('back_to_you')).toEqual(['approve', 'reject'])
    expect(rowVerbIds('failed')).toEqual(['retry', 'reject'])
    expect(rowVerbIds('starting')).toEqual(['undo'])
    expect(rowVerbIds('on_hold')).toEqual(['undo'])
    expect(rowVerbIds('done')).toEqual([])
    expect(rowVerbIds('running')).toEqual([])
  })

  it('holds Approve with the reason when this viewer may not approve', () => {
    expect(approveHeldWhy(row())).toBeNull()
    expect(approveHeldWhy(row({ canApprove: false, cannotApproveWhy: 'You may not change prices' }))).toBe('You may not change prices')
    expect(approveHeldWhy(row({ canApprove: false }))).toBe('You cannot approve this request.')
  })

  it('offers "Automate this kind…" on Claude\'s single requests only, held when the kind always needs a person', () => {
    expect(automateOffer(row())).toEqual({ offered: true, heldWhy: null })
    // A change plan is never automated: a rule is about one kind of Claude's requests.
    expect(automateOffer(row({ toolName: PLAN_TOOL_NAME, plan: { steps: 6, byStatus: { pending: 6 } } })).offered).toBe(false)
    expect(automateOffer(row({ toolName: PLAN_TOOL_NAME })).offered).toBe(false)
    expect(automateOffer(row({ asker: { kind: 'assistant', label: 'Assistant', person: 'Ana', connection: null } })).offered).toBe(false)
    expect(automateOffer(row({ automation: { level: 'ask', max: 'ask', whyWaits: null } }))).toEqual({ offered: true, heldWhy: 'This kind always needs you' })
    expect(automateOffer(row({ automation: { level: 'off', max: 'off', whyWaits: null } })).heldWhy).toBe('This kind always needs you')
    expect(automateOffer(row({ asker: { kind: 'fleet', label: 'Ads director', person: null, connection: null } })).offered).toBe(false)
  })

  it('confirms an approve with the server\'s run time', () => {
    expect(approvedText(new Date(NOW + 20_000).toISOString(), NOW)).toBe('Approved — runs in 20 s')
    expect(approvedText(new Date(NOW + 20_000).toISOString(), NOW, true)).toBe('Approved again — runs in 20 s')
    expect(approvedText(undefined, NOW)).toBe('Approved.')
  })
})

describe('bulk approve: one kind only (Decision 1 = A)', () => {
  const a = row({ id: 'a' })
  const b = row({ id: 'b' })

  it('counts and names the kind when every ticked row may go together', () => {
    expect(bulkApproveVerdict([a, b])).toEqual({ enabled: true, label: 'Approve 2 · Set master price', reason: null })
  })

  it('refuses mixed kinds, mixed askers, kinds never approved in bulk, and rows this viewer may not approve', () => {
    const other = row({ id: 'c', toolName: 'set-stock', title: 'Set stock' })
    expect(bulkApproveVerdict([a, other])).toMatchObject({ enabled: false, label: 'Approve 2', reason: 'Only one kind of request can be approved at once. You ticked 2 kinds.' })
    const fleet = row({ id: 'd', asker: { kind: 'fleet', label: 'Ads director', person: null, connection: null } })
    expect(bulkApproveVerdict([a, fleet]).reason).toBe('Only requests from one asker can be approved at once.')
    const refund = row({ id: 'e', bulkApprovable: false, bulkBlockedWhy: 'A refund sends the buyer money and cannot be taken back' })
    expect(bulkApproveVerdict([a, refund]).reason).toBe('A refund sends the buyer money and cannot be taken back')
    const refused = row({ id: 'f', canApprove: false, cannotApproveWhy: 'You may not change prices' })
    expect(bulkApproveVerdict([a, refused]).reason).toBe('You may not change prices')
  })

  it('refuses rows that no longer wait for a person, and more than the API cap', () => {
    expect(bulkApproveVerdict([a, row({ id: 'g', state: 'starting' })]).reason).toBe('1 of these is not waiting for you.')
    const many = Array.from({ length: BULK_MAX + 1 }, (_, i) => row({ id: `r${i}` }))
    expect(bulkApproveVerdict(many).reason).toBe(`At most ${BULK_MAX} requests can be approved at once. You ticked ${BULK_MAX + 1}.`)
    expect(bulkApproveVerdict([]).enabled).toBe(false)
  })

  it('W1-4 — a request that raises is left out of a bulk approve, and the button says so; alone it is held with why', () => {
    const strategy = (id: string, needsCode: string | null) => row({ id, toolName: 'set-ads-strategy', title: 'Set the ads strategy', needsCode, bulkApprovable: !needsCode, bulkBlockedWhy: needsCode ? 'A raise is approved on its own, with your authenticator code' : null })
    const raise = strategy('r1', 'It raises the ads strategy (Highest bid (cents)): approving it needs your authenticator code.')
    const lower = strategy('l1', null)
    expect(bulkApproveVerdict([raise, lower])).toEqual({
      enabled: true, label: 'Approve 1 of 2 · Set the ads strategy', reason: null,
      note: '1 that raises is left out: it is approved on its own, with your authenticator code.',
    })
    expect(bulkApproveVerdict([raise])).toMatchObject({ enabled: false, label: 'Approve 1 · Set the ads strategy', reason: 'It raises, so it is approved on its own: open it and approve it with your authenticator code.' })
    expect(bulkApproveVerdict([raise, strategy('r2', 'It raises the ads strategy (Goal): approving it needs your authenticator code.')]).reason)
      .toBe('Each of these raises, so each is approved on its own: open one and approve it with your authenticator code.')
  })

  it('W1-4 — the code sentence in plain words, and the Why of a waiting raise says the approve asks for the code', () => {
    const raise = row({ needsCode: 'It raises the ads strategy (Highest bid (cents), Most changes per engine run (actions)): approving it needs your authenticator code.' })
    expect(codeSentence(raise)).toBe('It raises the ads strategy (Highest bid, Most changes per engine run): approving it needs your authenticator code.')
    expect(codeSentence(row({}))).toBeNull()
    expect(whyText(raise)).toBe('Your rule for Set master price: Ask me · Approving asks for your authenticator code')
    expect(whyText({ ...raise, state: 'done', note: 'Ran', decider: null })).toBe('Ran')
  })

  it('rejects across kinds, but only rows that still wait', () => {
    expect(bulkRejectVerdict([a, row({ id: 'c', toolName: 'set-stock' })])).toEqual({ enabled: true, label: 'Reject 2', reason: null })
    expect(bulkRejectVerdict([a, row({ id: 'h', state: 'done' })]).reason).toBe('1 of these is not waiting for you.')
  })

  it('reports what the server did, naming each skipped row and why', () => {
    const name = (id: string) => (id === 'x' ? 'XR-1' : id)
    expect(bulkOutcomeText('approve', { done: 12, of: 12 }, name)).toBe('Approved 12.')
    expect(bulkOutcomeText('approve', { done: 10, of: 12, skipped: [{ id: 'x', why: 'it changed since it was asked' }] }, name))
      .toBe('Approved 10 of 12. Not done: XR-1 — it changed since it was asked.')
    expect(bulkOutcomeText('reject', { done: 0, of: 2, error: 'nothing selected' }, name)).toBe('Nothing was rejected: nothing selected')
  })
})

describe('the health strip: each tile is a filter', () => {
  it('shows the counts, and the oldest wait as an age', () => {
    expect(tileValue('needsYou', COUNTS, NOW)).toBe('7')
    expect(tileValue('running', COUNTS, NOW)).toBe('2')
    expect(tileValue('ranByRule', COUNTS, NOW)).toBe('14')
    expect(tileValue('oldest', COUNTS, NOW)).toBe('3 h')
    expect(tileValue('oldest', { ...COUNTS, oldestNeedsYouAt: null }, NOW)).toBe('none')
    expect(tileValue('failed', null, NOW)).toBe('—')
  })

  it('keeps the rows each tile counts', () => {
    const ctx = { oldestNeedsYouAt: COUNTS.oldestNeedsYouAt, now: NOW }
    expect(rowMatchesTile(row(), 'needsYou', ctx)).toBe(true)
    expect(rowMatchesTile(row({ state: 'back_to_you' }), 'needsYou', ctx)).toBe(true)
    expect(rowMatchesTile(row({ state: 'failed' }), 'needsYou', ctx)).toBe(false)
    expect(rowMatchesTile(row({ state: 'starting' }), 'running', ctx)).toBe(true)
    expect(rowMatchesTile(row({ state: 'failed' }), 'failed', ctx)).toBe(true)
    const ranToday = row({ state: 'done', decider: { kind: 'rule', label: 'Rule · Set price' }, decidedAt: '2026-10-05T08:00:00.000Z' })
    expect(rowMatchesTile(ranToday, 'ranByRule', ctx)).toBe(true)
    expect(rowMatchesTile({ ...ranToday, decidedAt: '2026-10-04T23:00:00.000Z' }, 'ranByRule', ctx)).toBe(false)
    expect(rowMatchesTile({ ...ranToday, decider: { kind: 'person', label: 'Awais' } }, 'ranByRule', ctx)).toBe(false)
    expect(rowMatchesTile(row(), 'oldest', ctx)).toBe(true)
    expect(rowMatchesTile(row({ requestedAt: '2026-10-05T10:00:00.000Z' }), 'oldest', ctx)).toBe(false)
  })
})

describe('group, phone, empty', () => {
  it('groups by kind, product or asker', () => {
    expect(groupKey(row(), 'kind')).toBe('Set master price')
    expect(groupKey(row(), 'product')).toBe('XR-GLOVE-M · Gale glove M')
    expect(groupKey(row({ target: null }), 'product')).toBe('No product named')
    expect(groupKey(row(), 'asker')).toBe('Claude · Ana')
  })

  it('shows two columns under 640 px: the request and one verb', () => {
    expect(isPhoneWidth(639)).toBe(true)
    expect(isPhoneWidth(640)).toBe(false)
    expect(PHONE_COLUMNS).toEqual(['request', 'actions'])
    // The Request cell's second line: the product's SKU, a plan's progress, else where.
    expect(requestSubline(row())).toBe('XR-GLOVE-M')
    expect(requestSubline(row({ state: 'running', plan: { steps: 6, byStatus: { done: 2 } } }))).toBe('2 of 6 done')
    expect(requestSubline(row({ target: { kind: 'product', id: null, sku: 'XR-1', name: null, count: 12, href: null } }))).toBe('12 products')
    expect(requestSubline(row({ target: null, nexusRecord: true }))).toBe('Nexus')
  })

  it('says plainly why the list is empty', () => {
    expect(emptyWords('open', false)).toEqual({ title: 'Nothing needs you right now.', message: "Claude's requests show up here." })
    expect(emptyWords('open', true).title).toBe('No requests match.')
  })
})

describe('polling stays light', () => {
  it('reads every 3 s while something is starting, running or on hold, else every 15 s', () => {
    expect(pollInterval([row()], { ...COUNTS, starting: 0, running: 0 })).toBe(POLL_IDLE_MS)
    expect(pollInterval([row({ state: 'on_hold' })], null)).toBe(POLL_FAST_MS)
    expect(pollInterval([row()], COUNTS)).toBe(POLL_FAST_MS)
  })

  it('re-reads what is on screen, one page at least and 200 at most', () => {
    expect(pollLimit(0)).toBe(100)
    expect(pollLimit(150)).toBe(150)
    expect(pollLimit(450)).toBe(200)
  })

  it('merges a poll with rows loaded past the poll\'s reach, and appends "Show more" without doubles', () => {
    const first = Array.from({ length: 3 }, (_, i) => row({ id: `r${i}` }))
    const polled = { rows: [row({ id: 'r0', state: 'starting' }), row({ id: 'r1' })], nextCursor: 'c2', total: 3 }
    expect(mergePolledPage({ rows: first, nextCursor: 'old' }, polled, 100)).toEqual({ rows: polled.rows, nextCursor: 'c2' })
    const merged = mergePolledPage({ rows: first, nextCursor: 'old' }, polled, 2)
    expect(merged.rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2'])
    expect(merged.rows[0].state).toBe('starting')
    expect(merged.nextCursor).toBe('old')
    expect(appendPage(first, { rows: [row({ id: 'r2' }), row({ id: 'r3' })], nextCursor: null, total: 4 }).map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3'])
  })
})

describe('AA-W2-5 — a request asked at Watch says what the rule would have done', () => {
  it('would have run alone, or outside the limits with the reason; nothing on other requests', async () => {
    const { watchVerdictWords } = await import('./queueWords')
    const base = { level: 'watch' as const, checkedAt: '2026-10-06T10:00:00.000Z', changes: 1 }
    expect(watchVerdictWords({ ruleVerdict: { ...base, wouldRun: true, check: null, why: null } })).toEqual({ label: 'Would have run alone', tone: 'success', why: null })
    expect(watchVerdictWords({ ruleVerdict: { ...base, wouldRun: false, check: 'limits', why: 'A bid raise above 15 %.' } }))
      .toEqual({ label: 'Outside your limits', tone: 'warning', why: 'A bid raise above 15 %.' })
    expect(watchVerdictWords({ ruleVerdict: null })).toBeNull()
    expect(watchVerdictWords({})).toBeNull()
  })
})
