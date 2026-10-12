import { describe, expect, it } from 'vitest'
import {
  acosText, aimDirection, bidProblem, bidsQuery, bidsTotalsOf, contestedMark, countWords, emptyWords, floorGivesBack, gridRowOf, isBidsShow,
  isContested, lastChangeWords, matchWord, NO_BID_FILTER, otherWriters, ownerChips, ownerHint, ownerLabel, ownerTone, ownerWords, parseBid,
  planHref, resultsWords, rowCurrency, rowMatches, rulePanelHref, showMatches, writerHref, writerName, inScopeOf, autoHeld, modeChangeLine,
  type BidRow, type BidTotals,
} from './bidsModel'

const row = (over: Partial<BidRow> = {}): BidRow => ({
  targetId: 't1',
  text: 'race jacket',
  match: 'EXACT',
  portfolio: { id: 'p1', name: 'Jackets', href: '/marketing/ads/portfolios/p1' },
  campaign: { id: 'c1', name: 'Jacket Exact', href: '/marketing/ads/campaigns/c1' },
  adGroup: { id: 'g1', name: 'Jacket group', href: '/marketing/ads/campaigns/c1/ad-groups/g1' },
  owner: { kind: 'BRAIN', name: 'Brain', id: 'brain' },
  bidNow: 40,
  nightFloor: false,
  maxCpc: 80,
  brainAim: 50,
  heldBy: null,
  lastChange: null,
  changes7d: 0,
  d7: { clicks: 10, orders: 1, spend: 400, acosPct: 20 },
  spark: [40, 40, 40, 40, 40, 40, 40],
  ...over,
})

const totals = (owners: Partial<BidTotals['owners']>): BidTotals => ({
  bids: Object.values(owners).reduce((a, b) => a + (b ?? 0), 0),
  shown: 0,
  owners: { BRAIN: 0, RULE: 0, PLAN: 0, PERSON: 0, ENGINE: 0, NONE: 0, ...owners },
  nightFloor: 0,
  changed7d: 0,
  d7: { clicks: 0, orders: 0, spend: 0, acosPct: null },
  truncated: false,
})

describe('who sets it', () => {
  it('names a rule by its own name, an engine "Engine" (never "Auto-bid"), nothing a dash', () => {
    expect(ownerLabel({ kind: 'RULE', name: 'Bids to 20 %', id: 'r1' })).toBe('Bids to 20 %')
    expect(ownerLabel({ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' })).toBe('Engine')
    expect(ownerLabel({ kind: 'PLAN', name: 'Jacket hours', id: 'g1' })).toBe('Hourly plan')
    expect(ownerLabel({ kind: 'PERSON', name: 'You', id: 'you' })).toBe('You')
    expect(ownerLabel({ kind: 'NONE', name: 'Nobody', id: null })).toBe('—')
    expect(ownerLabel({ kind: 'BRAIN', name: 'Brain · stopped', id: 'brain' })).toBe('Brain · stopped')
    expect(ownerHint({ kind: 'NONE', name: 'Nobody', id: null })).toBe('No automation sets this bid')
    expect(ownerHint({ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' })).toBe('Engine “Auto-bid” sets this bid')
  })

  it('puts the plan\'s name in the hover line, and tones you apart from automation', () => {
    expect(ownerHint({ kind: 'PLAN', name: 'Jacket hours', id: 'g1' })).toBe('Hourly plan “Jacket hours” sets this bid')
    expect(ownerTone('PERSON')).toBe('success')
    expect(ownerTone('NONE')).toBe('neutral')
    expect(ownerTone('RULE')).toBe('info')
  })

  it('offers All, then only the owners that have bids, with the totals\' counts', () => {
    const chips = ownerChips(totals({ BRAIN: 3, NONE: 2 }), 'ALL')
    expect(chips.map((c) => [c.key, c.label, c.count])).toEqual([['ALL', 'All', 5], ['BRAIN', 'Brain', 3], ['NONE', 'No one', 2]])
    expect(chips.find((c) => c.key === 'NONE')?.name).toBe('Nothing sets it')
  })

  it('draws no chips before the bids are read (no "All 0" while reading)', () => {
    expect(ownerChips(null, 'ALL')).toEqual([])
  })

  it('keeps the chosen owner\'s chip at 0 so it can be cleared', () => {
    expect(ownerChips(totals({ BRAIN: 3 }), 'RULE').map((c) => c.key)).toEqual(['ALL', 'BRAIN', 'RULE'])
  })
})

describe('a bid two writers write', () => {
  const owner = {
    kind: 'PLAN' as const, name: 'Jacket hours', id: 'g1', contested: true,
    alsoWrites: [{ kind: 'ENGINE' as const, name: 'Auto-bid', id: 'auto-bid' }, { kind: 'RULE' as const, name: 'Cut losers', id: 'r1' }],
  }

  it('marks the owner "+2" and names every other writer', () => {
    expect(contestedMark(owner)).toBe('+2')
    expect(isContested(owner)).toBe(true)
    expect(otherWriters(owner).map(writerName)).toEqual(['Engine', 'Cut losers'])
    expect(ownerWords(owner)).toBe('Hourly plan · also Engine, Cut losers')
    expect(ownerHint(owner)).toBe('Hourly plan “Jacket hours” sets this bid · also: Engine, Cut losers')
  })

  it('opens a rule\'s detail on this page, an hourly plan\'s page on the keyword\'s campaign, and the Brain\'s Why tab (A8)', () => {
    const g = gridRowOf(row({ owner }), 'it')
    expect(g.ownerHref).toBe('/marketing/ads/rules-automation/dayparting?market=IT&campaign=c1') // a plan has its own page
    expect(g.ownerWhy).toBe(false)
    expect(g.others.map((w) => [w.name, w.href, w.why])).toEqual([
      ['Engine', null, false],
      ['Cut losers', '/marketing/ads/rules-automation/bid?market=IT&rule=r1&tab=overview', false],
    ])
    expect(writerHref({ kind: 'BRAIN', id: 'brain' }, 'all')).toBeNull()
    expect(gridRowOf(row(), 'IT').ownerWhy).toBe(true)
    expect(writerHref({ kind: 'ENGINE', id: 'auto-bid' }, 'IT')).toBeNull()
    expect(writerHref({ kind: 'PLAN', id: 'g1' }, 'IT', 'c9')).toBe('/marketing/ads/rules-automation/dayparting?market=IT&campaign=c9')
    expect(planHref(null, 'all')).toBe('/marketing/ads/rules-automation/dayparting')
    expect(writerHref({ kind: 'PERSON', id: 'you' }, 'IT')).toBeNull()
    expect(writerHref({ kind: 'NONE', id: null }, 'IT')).toBeNull()
    expect(writerHref({ kind: 'RULE', id: null }, 'IT')).toBeNull()
    expect(rulePanelHref('r 1', null)).toBe('/marketing/ads/rules-automation/bid?rule=r+1&tab=overview')
  })

  it('has no mark with one writer, or on an older answer without the list', () => {
    expect(contestedMark({ kind: 'BRAIN', name: 'Brain', id: 'brain', contested: false, alsoWrites: [] })).toBeNull()
    expect(contestedMark({ kind: 'BRAIN', name: 'Brain', id: 'brain' })).toBeNull()
    expect(isContested({ kind: 'BRAIN', name: 'Brain', id: 'brain' })).toBe(false)
  })

  it('finds a bid by any of its writers', () => {
    expect(rowMatches(row({ owner }), { owner: 'ALL', search: 'cut losers' })).toBe(true)
    expect(rowMatches(row({ owner }), { owner: 'ENGINE', search: '' })).toBe(false) // the chips filter by the owner
  })
})

describe('match', () => {
  it('says Amazon\'s match types in one word', () => {
    expect(matchWord('EXACT')).toBe('Exact')
    expect(matchWord('SEARCH_LOOSE_MATCH')).toBe('Loose')
    expect(matchWord('PRODUCT_SUBSTITUTES')).toBe('Substitutes')
    expect(matchWord('asinSameAs')).toBe('Product')
    expect(matchWord('UNKNOWN')).toBe('—')
    expect(matchWord('SOME_NEW_TYPE')).toBe('Some new type')
  })
})

describe('filter and search', () => {
  it('filters by owner kind and by every word of the search', () => {
    const r = row()
    expect(rowMatches(r, NO_BID_FILTER)).toBe(true)
    expect(rowMatches(r, { owner: 'RULE', search: '' })).toBe(false)
    expect(rowMatches(r, { owner: 'BRAIN', search: 'jacket exact' })).toBe(true)
    expect(rowMatches(r, { owner: 'ALL', search: 'jackets' })).toBe(true) // the portfolio
    expect(rowMatches(r, { owner: 'ALL', search: 'gloves' })).toBe(false)
  })

  it('counts what it shows against the total', () => {
    expect(countWords(70, 70, false)).toBe('70 bids')
    expect(countWords(3, 70, true)).toBe('3 of 70')
    expect(countWords(1, 1, false)).toBe('1 bid')
  })
})

describe('money and time', () => {
  it('says each row\'s money in its own currency, else its market\'s, else the view\'s', () => {
    expect(rowCurrency({ currency: 'GBP', market: 'UK' }, 'all')).toBe('GBP')
    expect(rowCurrency({ market: 'UK' }, 'all')).toBe('GBP')
    expect(rowCurrency({ market: null }, 'UK')).toBe('GBP')
    expect(rowCurrency({}, null)).toBe('EUR')
    expect(gridRowOf(row({ currency: 'GBP', market: 'UK' }), 'all').currency).toBe('GBP')
  })

  it('says the last change as a signed step and how long ago, with from → to and who on hover', () => {
    const now = Date.parse('2026-10-10T08:00:00Z')
    const w = lastChangeWords({ from: 18, to: 15, at: '2026-10-10T06:00:00Z', by: { kind: 'BRAIN', name: 'Brain', id: 'brain' } }, 'EUR', now)
    expect(w?.text).toBe('−€0.03 · 2 h ago')
    expect(w?.title).toBe('€0.18 → €0.15 · Brain · 10 Oct, 08:00')
    expect(lastChangeWords({ from: 18, to: 20, at: '2026-10-10T06:00:00Z', by: { kind: 'RULE', name: 'Cut losers', id: 'r1' } }, 'GBP', now)?.text).toBe('+£0.02 · 2 h ago')
    expect(lastChangeWords(null, 'EUR', now)).toBeNull()
    // Hidden money: only the age.
    expect(lastChangeWords({ at: '2026-10-10T06:00:00Z', by: { kind: 'PERSON', name: 'You' } }, 'EUR', now)?.text).toBe('2 h ago')
  })

  it('points where the brain aims against the bid now', () => {
    expect(aimDirection({ bidNow: 40, brainAim: 50 })).toBe('up')
    expect(aimDirection({ bidNow: 40, brainAim: 30 })).toBe('down')
    expect(aimDirection({ bidNow: 40, brainAim: 40 })).toBe('same')
    expect(aimDirection({ bidNow: 40, brainAim: null })).toBeNull()
    expect(aimDirection({ bidNow: undefined, brainAim: 40 })).toBeNull()
  })

  it('reads the bid the night floor gives back from the 7-day line', () => {
    expect(floorGivesBack({ nightFloor: true, spark: [15, 15, 15, 15, 15, 15, 15] })).toBe(15)
    expect(floorGivesBack({ nightFloor: false, spark: [15] })).toBeNull()
    expect(floorGivesBack({ nightFloor: true, spark: undefined })).toBeNull()
  })

  it('says the 7-day results as numbers, and names them on hover', () => {
    const w = resultsWords({ clicks: 40, orders: 1, spend: 2000, acosPct: 25 }, 'EUR')
    expect([w.clicks, w.orders, w.acos]).toEqual(['40', '1', '25 %'])
    expect(w.title).toBe('7 d: 40 clicks · 1 order · ACoS 25 % · spend €20.00')
    expect(resultsWords({ clicks: 0, orders: 0 }, 'EUR').title).toBe('7 d: 0 clicks · 0 orders · ACoS —')
  })

  it('says ACoS, or a dash without sales', () => {
    expect(acosText(24.5)).toBe('24.5 %')
    expect(acosText(null)).toBe('—')
  })
})

describe('a direct bid', () => {
  it('reads a typed bid in either decimal mark', () => {
    expect(parseBid('0.15')).toBe(15)
    expect(parseBid('0,2')).toBe(20)
    expect(parseBid(' ')).toBeNull()
    expect(Number.isNaN(parseBid('abc') as number)).toBe(true)
    expect(Number.isNaN(parseBid('0.155') as number)).toBe(true)
  })

  it('refuses what Nexus or Amazon would refuse', () => {
    expect(bidProblem(null, 'EUR')).toBe('Type a bid')
    expect(bidProblem(Number.NaN, 'EUR')).toBe('Not a bid')
    expect(bidProblem(4, 'EUR')).toBe('At least €0.05')
    expect(bidProblem(100_001, 'EUR')).toMatch(/^At most /)
    expect(bidProblem(15, 'EUR')).toBeNull()
  })
})

describe('the grid row and the read', () => {
  it('turns the row\'s links into lists for the links cells', () => {
    const g = gridRowOf(row({ portfolio: null }), 'IT')
    expect(g.portfolios).toEqual([])
    expect(g.campaigns.map((c) => c.id)).toEqual(['c1'])
    expect(g.adGroups.map((c) => c.id)).toEqual(['g1'])
    expect(g.currency).toBe('EUR')
    expect(g.ownerHref).toBeNull()
    expect(g.ownerWhy).toBe(true)
    expect(g.others).toEqual([])
  })

  it('asks for the scope it is given; every market is no market', () => {
    expect(bidsQuery({ market: 'it' })).toBe('?market=IT')
    expect(bidsQuery({ market: 'all' })).toBe('')
    expect(bidsQuery({ market: null, campaignId: 'c1', adGroupId: 'g1' })).toBe('?campaignId=c1&adGroupId=g1')
  })
})

describe('the page\'s tiles (M1): what they show and the numbers they read', () => {
  const rows = [
    row({ targetId: 'a', changes7d: 2 }),
    row({ targetId: 'b', owner: { kind: 'PLAN', name: 'Jacket hours', id: 'g1', contested: true, alsoWrites: [{ kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' }] } }),
    row({ targetId: 'c' }),
  ]
  it('narrows the rows to the tile: changed in 7 d, two writers (no filter nobody can pick, C-UI 10)', () => {
    expect(rows.filter((r) => showMatches(r, 'changed7d')).map((r) => r.targetId)).toEqual(['a'])
    expect(rows.filter((r) => showMatches(r, 'contested')).map((r) => r.targetId)).toEqual(['b'])
    expect(rows.filter((r) => showMatches(r, undefined))).toHaveLength(3)
    expect(isBidsShow('contested')).toBe(true)
    expect(isBidsShow('waiting')).toBe(false)
    expect(isBidsShow('on')).toBe(false)
  })

  it('reports the read\'s totals, never narrowed by a filter: the server\'s changed count and the rows\' clashes', () => {
    const t = bidsTotalsOf({ rows, totals: { ...totals({ BRAIN: 2, PLAN: 1 }), changed7d: 1 } })
    expect(t).toEqual({ bids: 3, changed7d: 1, contested: 1, owners: { BRAIN: 2, RULE: 0, PLAN: 1, PERSON: 0, ENGINE: 0, NONE: 0 }, truncated: false })
  })

  it('says why the table is empty: a filter, a tile, or no bids', () => {
    expect(emptyWords(undefined, true, true)).toEqual({ title: 'No bid matches', clear: true })
    expect(emptyWords('changed7d', false, true).title).toBe('No bid changed in 7 d')
    expect(emptyWords('contested', false, true).title).toBe('No bid has two writers')
    expect(emptyWords(undefined, false, false)).toEqual({ title: 'No live bids', clear: false })
  })
})

describe('keyword Auto', () => {
  it('knows which columns the rows in scope need: an engine runs a keyword (Auto · Goal), the Brain sets a bid (C-UI 1)', () => {
    const none = { kind: 'NONE' as const, name: 'Nobody', id: null }
    expect(inScopeOf([row({ owner: none, auto: 'NONE' })])).toEqual({ engine: false, brain: false })
    expect(inScopeOf([row({ owner: none, auto: 'MANUAL' })])).toEqual({ engine: true, brain: false })
    expect(inScopeOf([row({ auto: 'AUTO' })])).toEqual({ engine: true, brain: true })
    expect(inScopeOf([])).toEqual({ engine: false, brain: false })
  })

  it('switches only where an engine runs the keyword, and says why not', () => {
    expect(autoHeld({ auto: 'NONE', autoWhy: 'Off the allowlist' }, true)).toBe('Off the allowlist')
    expect(autoHeld({ auto: 'NONE' }, true)).toBe('No engine runs this campaign')
    expect(autoHeld({ auto: 'AUTO' }, false)).toBe('Needs the ads bids permission')
    expect(autoHeld({ auto: 'MANUAL' }, true)).toBeNull()
    expect(gridRowOf(row({ auto: 'AUTO' }), 'IT').autoOn).toBe(true)
    expect(gridRowOf(row({ auto: 'MANUAL' }), 'IT').autoOn).toBe(false)
  })

  it('reviews a switch in plain words; handing back is counted as letting automation do more', () => {
    expect(modeChangeLine(row(), 'MANUAL')).toEqual({ id: 't1', what: 'Auto', now: 'Auto', next: 'Manual', note: 'The brain stops moving this keyword until you switch it back to Auto', raise: false })
    expect(modeChangeLine(row({ owner: { kind: 'ENGINE', name: 'Auto-bid', id: 'auto-bid' } }), 'AUTO')).toMatchObject({ now: 'Manual', next: 'Auto', note: 'The engine moves this keyword again from its next run', raise: true })
  })
})
