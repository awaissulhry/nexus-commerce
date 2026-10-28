import { describe, expect, it } from 'vitest'
import {
  KIND_CHIPS,
  MANAGE_FIXES,
  SIZE_GUIDE_RULE,
  dismissBulkHeld,
  dismissResultWords,
  doneWords,
  emptyHelp,
  emptyTitle,
  englishLines,
  evidenceLines,
  evidenceLink,
  fixEditBody,
  fixForm,
  filterFixes,
  fixesApiParams,
  tabCounts,
  metaWords,
  parseFixStatus,
  parseKinds,
  proposalLines,
  proposeResultWords,
  sendBulkHeld,
  sendBulkLabel,
  sendBulkTip,
  sendLabel,
  sendPlan,
  sentWords,
  targetWords,
  toggleKind,
  toolbarCount,
  wayOut,
  withdrawHeld,
  type FixItem,
} from './fixesModel'

const fix = (over: Partial<FixItem> = {}): FixItem => ({
  id: 'f-1',
  kind: 'BULLETS',
  kindWords: 'Bullets',
  status: 'OPEN',
  title: 'Say the jacket runs small',
  detail: null,
  product: { id: 'p-1', sku: 'TJ-BLK', name: 'Touring jacket' },
  market: 'DE',
  theme: { key: 'FIT_SIZING', label: 'Fit & sizing' },
  spikeId: null,
  proposal: { bullets: ['Runs small: pick one size up'], language: 'de', english: ['Runs small: pick one size up'] },
  held: null,
  plan: null,
  task: null,
  applied: null,
  lastSend: null,
  source: 'ai',
  createdBy: null,
  createdAt: '2026-10-24T10:00:00Z',
  ...over,
})

describe('tabs and kinds', () => {
  it('reads the tab and the kinds from the address', () => {
    expect(parseFixStatus('sent')).toBe('SENT')
    expect(parseFixStatus('APPLY')).toBe('OPEN')
    expect(parseKinds('aplus,task,nonsense')).toEqual(['APLUS', 'TASK'])
    expect(parseKinds(null)).toEqual([])
    expect(toggleKind(['TASK'], 'BULLETS')).toEqual(['BULLETS', 'TASK'])
    expect(toggleKind(['BULLETS', 'TASK'], 'BULLETS')).toEqual(['TASK'])
    expect(fixesApiParams('p-1')).toEqual({ productId: 'p-1', limit: '300' })
    expect(emptyTitle('SENT', false)).toBe('Nothing waits for approval')
    expect(emptyTitle('OPEN', true)).toBe('No fixes of these kinds here')
  })
})

describe('the list a tab shows', () => {
  const items = [
    fix({ id: 'a', market: 'DE' }),
    fix({ id: 'b', market: 'IT', kind: 'APLUS' }),
    fix({ id: 'c', market: null, kind: 'TASK' }),
    fix({ id: 'd', market: 'DE', status: 'SENT' }),
  ]

  it('applies the tab, the kind chips and the market, and counts each tab the same way', () => {
    expect(filterFixes(items, { status: 'OPEN', kinds: [], market: null }).map((f) => f.id)).toEqual(['a', 'b', 'c'])
    expect(filterFixes(items, { status: 'OPEN', kinds: [], market: 'DE' }).map((f) => f.id)).toEqual(['a', 'c'])
    expect(filterFixes(items, { status: 'OPEN', kinds: ['APLUS'], market: null }).map((f) => f.id)).toEqual(['b'])
    expect(tabCounts(items, { kinds: [], market: 'DE' })).toEqual({ OPEN: 2, SENT: 1, APPLIED: 0, DISMISSED: 0 })
  })

  it('counts the list in its toolbar as the other Reviews lists do, and the ticked ones while fixes are ticked', () => {
    expect(toolbarCount('OPEN', 2, 0)).toEqual({ n: 2, words: 'open fixes' })
    expect(toolbarCount('OPEN', 1, 0)).toEqual({ n: 1, words: 'open fix' })
    expect(toolbarCount('OPEN', 3, 2)).toEqual({ n: 2, words: 'selected' })
    expect(toolbarCount('SENT', 1, 0)).toEqual({ n: 1, words: 'fix waiting for approval' })
    expect(toolbarCount('APPLIED', 0, 0)).toEqual({ n: 0, words: 'applied fixes' })
    expect(toolbarCount('DISMISSED', 4, 0)).toEqual({ n: 4, words: 'dismissed fixes' })
  })
})

describe('one fix', () => {
  it('says where it goes — Recall check only ever in your own warehouses', () => {
    expect(targetWords(fix())).toEqual(['Product text · German', 'every channel that shows these bullets'])
    expect(targetWords(fix({ kind: 'APLUS', market: 'ES' }))).toEqual(['Amazon Spain · A+ content', 'a draft Amazon checks'])
    expect(targetWords(fix({ kind: 'RECALL_FLAG' }))).toEqual(['Stock hold · your own warehouses only', 'never Amazon FBA stock'])
    expect(targetWords(fix({ kind: 'TASK' }))).toEqual(['A task: nothing changes on a channel'])
  })

  it('shows what it proposes and what that means in English', () => {
    expect(proposalLines(fix())).toEqual({ heading: 'Proposed bullets (German)', lines: ['Runs small: pick one size up'] })
    expect(proposalLines(fix({ kind: 'APLUS', proposal: { language: 'en', module: { headline: 'Fit', body: 'Pick one size up.' } } })).lines).toEqual(['Fit', 'Pick one size up.'])
    expect(proposalLines(fix({ kind: 'RECALL_FLAG', proposal: { language: 'en', days: 7 } })).lines[0]).toMatch(/for 7 days.*never held/)
    expect(englishLines(fix())).toEqual(['Runs small: pick one size up'])
    expect(englishLines(fix({ proposal: { language: 'en', english: 'x' } }))).toBeNull()
    expect(metaWords(fix(), Date.parse('2026-10-26T12:00:00Z'))).toBe('Written by AI from the reviews · 2 days ago')
  })

  it('links its evidence: the alert it came from, or the theme’s reviews', () => {
    const scope = { channel: null, market: null, period: '30d' as const }
    expect(evidenceLink(fix({ spikeId: 's-1' }), scope)).toEqual({ label: 'The alert it came from', href: '/marketing/reviews/insights/alerts?market=DE&product=p-1&status=ALL' })
    expect(evidenceLink(fix(), scope)).toEqual({ label: 'Reviews about Fit & sizing', href: '/marketing/reviews/inbox?period=30d&market=DE&theme=FIT_SIZING&q=TJ-BLK' })
    expect(evidenceLink(fix({ theme: null }), scope)).toBeNull()
  })

  it('offers the way out its reason names', () => {
    expect(wayOut('Say what the bullets mean in English (Edit the proposal) before sending.')).toBe('edit')
    expect(wayOut('TEST-P keeps no bullet points in Nexus, so one sizing bullet would replace what the channels show. Create a task instead, and add the advice where its text is kept.')).toBe('task')
    expect(wayOut('Write the sizing bullet point in Italian (Edit the proposal) before sending: the product’s text is kept in Italian.')).toBe('edit')
    expect(wayOut('Its bullet points already say this: dismiss this fix.')).toBe('dismiss')
    expect(wayOut('Its product is no longer in Nexus: dismiss this fix.')).toBe('dismiss')
    expect(sendLabel(fix({ kind: 'TASK' }))).toBe('Create task')
  })

  it('withdraws only while the plan waits, and says what a sent or done fix waits for', () => {
    const waiting = fix({ status: 'SENT', plan: { approvalId: 'ap', state: 'waiting', words: 'Change plan waits on the Approvals page', sentBy: 'Teammate A', sentAt: null, expiresAt: '2026-10-28T10:00:00Z' } })
    expect(withdrawHeld(waiting)).toBeNull()
    expect(withdrawHeld(fix({ status: 'SENT', plan: { ...waiting.plan!, state: 'done' } }))).toMatch(/undo it from its change plan/)
    expect(sentWords(waiting)).toBe('Change plan waits on the Approvals page · sent by Teammate A · expires 28 Oct')
    expect(doneWords(fix({ status: 'APPLIED', applied: { words: 'The change plan ran', at: '2026-10-25T10:00:00Z', approvalId: 'ap' } }))).toBe('The change plan ran · 25 Oct')
    expect(doneWords(fix({ status: 'DISMISSED' }))).toBe('Dismissed: nothing was sent')
  })
})

describe('the bulk bar', () => {
  const a = fix({ id: 'a' })
  const b = fix({ id: 'b', kind: 'APLUS', title: 'A+ for Spain', held: 'Amazon refuses A+ content without Brand Registry.' })
  const t = fix({ id: 't', kind: 'TASK' })

  it('puts the sendable fixes in one plan, tasks apart, and names a fix that cannot be sent', () => {
    expect(sendPlan([a, b, t])).toEqual({ send: ['a'], tasks: ['t'], blocked: [{ id: 'b', title: 'A+ for Spain', words: 'Amazon refuses A+ content without Brand Registry.' }] })
    expect(sendBulkLabel(sendPlan([a, t]))).toBe('Send 1 for approval + 1 task')
    expect(sendBulkLabel(sendPlan([t]))).toBe('Create 1 task')
    expect(sendBulkLabel(sendPlan([a, fix({ id: 'c' })]))).toBe('Send 2 for approval')
  })

  it('holds Send while a ticked fix cannot go, naming it, and says what happens when it can', () => {
    expect(sendBulkHeld(true, sendPlan([a, b]))).toBe('“A+ for Spain” cannot be sent: Amazon refuses A+ content without Brand Registry. Untick it to send the rest.')
    expect(sendBulkHeld(true, sendPlan([a, b, fix({ id: 'd', held: 'x.', title: 'D' })]))).toMatch(/\(and 1 more like it\)\.$/)
    expect(sendBulkHeld(false, sendPlan([a]))).toBe(MANAGE_FIXES)
    expect(sendBulkHeld(true, sendPlan([a, t]))).toBeNull()
    expect(sendBulkTip(sendPlan([a, t]))).toBe('One change plan with 1 fix: a person who may approve changes decides it on the Approvals page; only then does Nexus change anything. 1 task is created at once, without approval: nothing changes on a channel.')
    expect(dismissBulkHeld(true, [a])).toBeNull()
    expect(dismissBulkHeld(true, [fix({ status: 'SENT' })])).toMatch(/only an open fix/)
  })

  it('says the result in the server’s count', () => {
    expect(proposeResultWords({ changed: 2, held: [], sent: { approvalId: 'ap', fixes: 2, steps: 3, expiresAt: null, summary: null }, tasks: 1 })).toBe('2 fixes sent for approval in one change plan (3 steps) · 1 task created')
    expect(proposeResultWords({ changed: 0, held: [{ id: 'b', words: 'No ASIN.' }], sent: null, tasks: 0 })).toBe('Nothing was sent · 1 held: No ASIN.')
    expect(dismissResultWords(2, [])).toBe('2 fixes dismissed')
  })
})

describe('edit the proposal', () => {
  it('fills the window from the fix', () => {
    expect(fixForm(fix())).toMatchObject({ title: 'Say the jacket runs small', bullets: 'Runs small: pick one size up', language: 'de', english: 'Runs small: pick one size up', days: 14 })
  })

  it('sends only what changed, checked as the API checks it', () => {
    const f = fix()
    expect(fixEditBody(f, fixForm(f))).toEqual({ body: null, error: null })
    expect(fixEditBody(f, { ...fixForm(f), bullets: 'Runs small\n\n Pick one size up ' })).toEqual({ body: { bullets: ['Runs small', 'Pick one size up'] }, error: null })
    expect(fixEditBody(f, { ...fixForm(f), english: '' }).error).toMatch(/in English/)
    expect(fixEditBody(f, { ...fixForm(f), bullets: '' }).error).toBe('Write 1 to 10 bullet points, one per line.')
    expect(fixEditBody(f, { ...fixForm(f), bullets: 'x'.repeat(503) }).error).toBe('Bullet 1 is 3 characters too long (500 at most).')
    expect(fixEditBody(f, { ...fixForm(f), title: ' ' }).error).toBe('The title needs 1 to 200 characters.')
    const a = fix({ kind: 'APLUS', proposal: { language: 'en', module: { headline: 'Fit', body: 'Old' } } })
    expect(fixEditBody(a, { ...fixForm(a), body: 'New text' }).body).toEqual({ module: { headline: 'Fit', body: 'New text' } })
    const r = fix({ kind: 'RECALL_FLAG', proposal: { language: 'en', days: 14 } })
    expect(fixEditBody(r, { ...fixForm(r), days: 120 }).error).toBe('Hold for 1 to 90 days.')
    expect(fixEditBody(r, { ...fixForm(r), days: 7 }).body).toEqual({ days: 7 })
  })
})

describe('a size-guide fix (from fit by size)', () => {
  const sizeGuide = {
    direction: 'small' as const, sizes: ['M', 'L'], allSizes: false, reviews: 7, returns: 4,
    advice: 'Tell buyers to order one size up in sizes M–L: in the size guide and in the listing text.',
    line: 'Le taglie M–L vestono piccole: consigliamo di ordinare una taglia in più.',
    evidence: ['M — Runs small: 6 of 7 fit mentions (86%), from 5 reviews and 2 returns.', 'L — Runs small: 5 of 5 fit mentions (100%), from 3 reviews and 2 returns.'],
  }
  const sg = (over: Partial<FixItem> = {}) => fix({
    kind: 'SIZE_GUIDE', kindWords: 'Size guide', market: null, source: 'fit-by-size',
    title: 'Runs small: 7 reviews and 4 size returns say so for sizes M–L',
    proposal: { language: 'it', english: 'Sizes M–L run small: we suggest ordering one size up.', sizeGuide },
    ...over,
  })

  it('the chip is real: it filters size-guide fixes, and says nothing of later', () => {
    expect(KIND_CHIPS.find((c) => c.kind === 'SIZE_GUIDE')).toEqual({ kind: 'SIZE_GUIDE', label: 'Size guide' })
    expect(KIND_CHIPS.map((c) => c.label).join(' ')).not.toMatch(/later|sample/i)
    expect(filterFixes([fix({ id: 'b' }), sg({ id: 's' })], { status: 'OPEN', kinds: ['SIZE_GUIDE'], market: 'DE' }).map((f) => f.id)).toEqual(['s'])
  })

  it('says what is wrong, the change, where it goes, and the evidence', () => {
    expect(proposalLines(sg())).toEqual({
      heading: 'Proposed change',
      lines: [
        'Tell buyers to order one size up in sizes M–L: in the size guide and in the listing text.',
        'New last bullet point (Italian): “Le taglie M–L vestono piccole: consigliamo di ordinare una taglia in più.”',
        'The size guide is not kept in Nexus: add the same advice to it by hand.',
      ],
    })
    expect(proposalLines(sg({ proposal: { language: 'nl', sizeGuide: { ...sizeGuide, line: null } } })).lines[1]).toBe('No bullet point in Dutch yet: edit the proposal.')
    expect(englishLines(sg())).toEqual(['Sizes M–L run small: we suggest ordering one size up.'])
    expect(targetWords(sg())).toEqual(['Product text · Italian', 'every channel that shows these bullets', 'Size guide: by hand, outside Nexus'])
    expect(evidenceLines(sg())).toEqual({ heading: 'Evidence · last 12 months', lines: sizeGuide.evidence })
    expect(evidenceLines(fix())).toBeNull()
    expect(metaWords(sg(), Date.parse('2026-10-24T12:00:00Z'))).toBe('Found by Nexus in fit by size · today')
    expect(evidenceLink(sg(), { channel: 'EBAY', market: 'IT', period: '30d' })).toEqual({ label: 'Its fit per size', href: '/marketing/reviews/insights/products?period=12m&product=p-1' })
  })

  it('a fix the re-check closed says why; an empty list says what makes one', () => {
    expect(doneWords(sg({ status: 'DISMISSED', closed: { words: 'Closed by Nexus: the reviews and returns of the last 12 months no longer say sizes M–L run small.', at: '2026-10-27T10:00:00Z' } })))
      .toBe('Closed by Nexus: the reviews and returns of the last 12 months no longer say sizes M–L run small. · 27 Oct')
    expect(emptyTitle('OPEN', true, ['SIZE_GUIDE'])).toBe('No size runs small or large')
    expect(emptyTitle('DISMISSED', true, ['SIZE_GUIDE'])).toBe('No size-guide fixes here')
    expect(emptyHelp('OPEN', ['SIZE_GUIDE'])).toEqual({ description: `${SIZE_GUIDE_RULE} No product meets that now; Nexus checks again when this page reads.`, link: 'themes' })
    expect(emptyHelp('SENT', ['SIZE_GUIDE']).description).toMatch(/None is waiting for approval\.$/)
    expect(emptyHelp('OPEN', []).link).toBe('alerts')
  })

  it('edits the sizing bullet and its English, checked as the API checks them', () => {
    const f = sg()
    expect(fixForm(f)).toMatchObject({ line: sizeGuide.line, english: 'Sizes M–L run small: we suggest ordering one size up.' })
    expect(fixEditBody(f, fixForm(f))).toEqual({ body: null, error: null })
    expect(fixEditBody(f, { ...fixForm(f), line: ' Prendete una taglia in più. ', english: 'Take one size up.' })).toEqual({ body: { line: 'Prendete una taglia in più.', english: 'Take one size up.' }, error: null })
    expect(fixEditBody(f, { ...fixForm(f), line: '' }).error).toBe('The bullet point needs 1 to 500 characters.')
    expect(fixEditBody(f, { ...fixForm(f), english: ' ' }).error).toMatch(/in English/)
    expect(fixEditBody(f, { ...fixForm(f), language: 'de' }).body).toBeNull()
  })
})
