import { describe, expect, it } from 'vitest'
import { historyRows, type HistoryAudit, type HistoryNames } from './history'
import {
  closeBlockers,
  codeFromName,
  groupCodeOf,
  mergeIdProblems,
  mergePlan,
  moveProblems,
  readyMadePreview,
  readyMadeRows,
  unitFieldProblems,
  type MergeOrderRow,
  type ReadyMadeFacts,
  type ReadyMadeUnit,
  type TreeUnit,
} from './rules'

/** Made-up ids and names only. */
const tree = (entries: Record<string, { parentId: string | null; closed?: boolean }>): Map<string, TreeUnit> => new Map(Object.entries(entries).map(([id, unit]) => [id, { parentId: unit.parentId, closed: unit.closed ?? false }]))
const codes = (problems: readonly { code: string }[]) => problems.map((problem) => problem.code)

describe('move (design § 5zb "Move…")', () => {
  // top → floor → teamA → cell
  const units = tree({ top: { parentId: null }, floor: { parentId: 'top' }, teamA: { parentId: 'floor' }, cell: { parentId: 'teamA' }, old: { parentId: 'top', closed: true } })

  it('moves under another open unit, or to the top', () => {
    expect(moveProblems('teamA', 'top', units)).toEqual([])
    expect(moveProblems('teamA', null, units)).toEqual([])
  })

  it('refuses itself, a unit under it (a cycle), a closed or unknown unit', () => {
    expect(codes(moveProblems('teamA', 'teamA', units))).toEqual(['UNIT_UNDER_ITSELF'])
    expect(codes(moveProblems('floor', 'cell', units))).toEqual(['UNIT_CYCLE'])
    expect(codes(moveProblems('top', 'teamA', units))).toEqual(['UNIT_CYCLE'])
    expect(codes(moveProblems('teamA', 'old', units))).toEqual(['PARENT_CLOSED'])
    expect(codes(moveProblems('teamA', 'nowhere', units))).toEqual(['PARENT_NOT_FOUND'])
    expect(moveProblems('floor', 'cell', units)[0]).toMatchObject({ field: 'parentId', words: expect.stringContaining('move that unit first') })
  })

  it('keeps the structure under 50 levels (the walk up from the new unit above, as the database counts)', () => {
    const chain: Record<string, { parentId: string | null }> = { u0: { parentId: null } }
    for (let n = 1; n < 60; n += 1) chain[`u${n}`] = { parentId: `u${n - 1}` }
    chain.loose = { parentId: null }
    const deep = tree(chain)
    expect(moveProblems('loose', 'u48', deep)).toEqual([])
    expect(codes(moveProblems('loose', 'u49', deep))).toEqual(['UNIT_TOO_DEEP'])
  })
})

describe('the profile (design § 5zd "Edit the profile")', () => {
  it('takes a kind of 1 to 40, what it does in 1 to 500, 1 to 999 baskets, one of the 12 icons and 10 tones', () => {
    expect(unitFieldProblems({ name: 'Team Noor', kindWord: 'Line', about: 'Sews the jackets (made up).', maxBaskets: 12, pictureKind: 'ICON', pictureIcon: 'scissors', pictureColour: 'emerald', worksForPartyIds: ['p1', 'p2'] })).toEqual([])
    expect(
      codes(
        unitFieldProblems({
          name: ' ',
          kindWord: 'x'.repeat(41),
          about: 'y'.repeat(501),
          maxBaskets: 0,
          pictureKind: 'ICON',
          pictureIcon: 'rocket',
          pictureColour: 'gold',
          worksForPartyIds: ['p1', 'p1'],
        }),
      ),
    ).toEqual(['NAME_LENGTH', 'KIND_WORD_LENGTH', 'PICTURE_ICON_UNKNOWN', 'PICTURE_COLOUR_UNKNOWN', 'ABOUT_LENGTH', 'MAX_BASKETS_RANGE', 'WORKS_FOR_TWICE'])
    expect(codes(unitFieldProblems({ maxBaskets: 1000 }))).toEqual(['MAX_BASKETS_RANGE'])
    expect(codes(unitFieldProblems({ maxBaskets: 2.5 }))).toEqual(['MAX_BASKETS_RANGE'])
    expect(codes(unitFieldProblems({ pictureKind: 'ICON', pictureIcon: null }))).toEqual(['PICTURE_ICON_MISSING'])
    expect(unitFieldProblems({ pictureKind: 'LETTERS', pictureIcon: null })).toEqual([])
  })

  it('names the stand-in before the last day, which is today or later', () => {
    expect(codes(unitFieldProblems({ standInEmployeeId: null, standInUntil: '2026-12-01' }))).toEqual(['STAND_IN_UNTIL_ALONE'])
    expect(codes(unitFieldProblems({ standInEmployeeId: 'e1', standInUntil: '2026-11-01' }, '2026-11-28'))).toEqual(['STAND_IN_UNTIL_PAST'])
    expect(unitFieldProblems({ standInEmployeeId: 'e1', standInUntil: '2026-11-28' }, '2026-11-28')).toEqual([])
    expect(unitFieldProblems({ standInEmployeeId: 'e1', standInUntil: null })).toEqual([])
  })

  it('makes a code from the name when none is typed, free on the site', () => {
    expect(codeFromName('Floor A', new Set())).toBe('FLOOR-A')
    expect(codeFromName('Qualità & Packing', new Set())).toBe('QUALITA-PACKING')
    expect(codeFromName('Floor A', new Set(['FLOOR-A', 'FLOOR-A-2']))).toBe('FLOOR-A-3')
    expect(codeFromName('***', new Set())).toBe('UNIT')
    expect(codeFromName('A very long made-up unit name indeed', new Set()).length).toBeLessThanOrEqual(20)
  })
})

describe('close (design § 5zb "Close…")', () => {
  it('says what to move first: the units under it, its people, its open orders', () => {
    expect(closeBlockers({ units: 0, people: 0, openOrders: 0 })).toEqual([])
    expect(closeBlockers({ units: 2, people: 1, openOrders: 3 })).toEqual([
      { code: 'CLOSE_HAS_UNITS', words: 'Move the 2 units under it to another unit first.' },
      { code: 'CLOSE_HAS_PEOPLE', words: 'Move its 1 person to another unit first.' },
      { code: 'CLOSE_HAS_ORDERS', words: 'Give its 3 open orders to another team first.' },
    ])
  })
})

describe('merge (design § 5zd: any number of units)', () => {
  const today = '2026-11-28'
  const row = (id: string, salesOrderId: string, teamId: string, extra: Partial<MergeOrderRow> = {}): MergeOrderRow => ({ id, salesOrderId, companyId: 'c', partyId: 'p', siteId: 's', teamId, inCharge: false, basketShare: null, bundleIds: [], givenBy: 'USER', ...extra })

  it('refuses nothing to merge, the kept unit ticked, a unit ticked twice, more than 50', () => {
    expect(codes(mergeIdProblems('k', []))).toEqual(['MERGE_NOTHING'])
    expect(codes(mergeIdProblems('k', ['a', 'k']))).toEqual(['MERGE_KEEP_TICKED'])
    expect(codes(mergeIdProblems('k', ['a', 'a']))).toEqual(['MERGE_TWICE'])
    expect(codes(mergeIdProblems('k', Array.from({ length: 51 }, (_, n) => `m${n}`)))).toEqual(['MERGE_TOO_MANY'])
    expect(mergeIdProblems('k', ['a', 'b'])).toEqual([])
  })

  it('moves the people in (effective today; a leader loses the flag), the units under the merged ones, and keeps the kept team once per order', () => {
    const plan = mergePlan({
      keepId: 'k',
      mergeIds: ['a', 'b'],
      today,
      units: [
        { id: 'top', parentId: null, closed: false },
        { id: 'k', parentId: 'top', closed: false },
        { id: 'a', parentId: 'top', closed: false },
        { id: 'b', parentId: 'top', closed: false },
        { id: 'cellA', parentId: 'a', closed: false },
        { id: 'shut', parentId: 'b', closed: true },
      ],
      members: [
        { id: 'mk', teamId: 'k', employeeId: 'ek', isLead: true, since: '2026-01-01' },
        { id: 'ma', teamId: 'a', employeeId: 'ea', isLead: true, since: '2026-01-01' },
        { id: 'mb', teamId: 'b', employeeId: 'eb', isLead: false, since: today },
      ],
      orderRows: [
        // Order 1: the kept team and A are on it (SPLIT 6 + 4); A is in charge, nobody else → the kept row takes the charge and A's share.
        row('r1k', 'o1', 'k', { basketShare: 6, bundleIds: ['b1'] }),
        row('r1a', 'o1', 'a', { basketShare: 4, inCharge: true, bundleIds: ['b2'] }),
        // Order 2: A and B, not the kept team; B is in charge → ONE new row of the kept team (never twice), in charge.
        row('r2a', 'o2', 'a'),
        row('r2b', 'o2', 'b', { inCharge: true, givenBy: 'RULE' }),
        // Order 3: A with another team in charge → a new row of the kept team, NOT in charge.
        row('r3a', 'o3', 'a'),
        row('r3x', 'o3', 'x', { inCharge: true }),
        // Order 4: only other teams → untouched.
        row('r4x', 'o4', 'x', { inCharge: true }),
      ],
    })
    expect(plan.keptParent).toBeNull()
    expect(plan.reparent).toEqual([{ unitId: 'cellA', from: 'a' }])
    expect(plan.people).toEqual([
      { employeeId: 'ea', fromTeamId: 'a', plan: { kind: 'MOVE', end: { id: 'ma', until: '2026-11-27' }, remove: null, start: { teamId: 'k', since: today }, wasLead: true } },
      { employeeId: 'eb', fromTeamId: 'b', plan: { kind: 'MOVE', end: null, remove: 'mb', start: { teamId: 'k', since: today }, wasLead: false } },
    ])
    expect([...plan.endRows].sort()).toEqual(['r1a', 'r2a', 'r2b', 'r3a'])
    expect(plan.updateRows).toEqual([{ rowId: 'r1k', salesOrderId: 'o1', inCharge: true, basketShare: 10, bundleIds: ['b1', 'b2'], fromRowIds: ['r1a'] }])
    expect(plan.insertRows).toEqual([
      { salesOrderId: 'o2', companyId: 'c', partyId: 'p', siteId: 's', inCharge: true, basketShare: null, bundleIds: [], givenBy: 'RULE', fromRowIds: ['r2a', 'r2b'] },
      { salesOrderId: 'o3', companyId: 'c', partyId: 'p', siteId: 's', inCharge: false, basketShare: null, bundleIds: [], givenBy: 'USER', fromRowIds: ['r3a'] },
    ])
    // Never the kept team twice on one order, and one team in charge per order.
    for (const orderId of ['o1', 'o2', 'o3']) {
      const keptRows = [...plan.updateRows.filter((update) => update.salesOrderId === orderId), ...plan.insertRows.filter((insert) => insert.salesOrderId === orderId)]
      expect(keptRows.length).toBeLessThanOrEqual(1)
    }
  })

  it('the kept unit takes the place of the highest merged unit above it (no cycle)', () => {
    // top → a → mid → k : merging a into k puts k under top, and mid (under a) under k.
    const plan = mergePlan({
      keepId: 'k',
      mergeIds: ['a'],
      today,
      units: [
        { id: 'top', parentId: null, closed: false },
        { id: 'a', parentId: 'top', closed: false },
        { id: 'mid', parentId: 'a', closed: false },
        { id: 'k', parentId: 'mid', closed: false },
      ],
      members: [],
      orderRows: [],
    })
    expect(plan.keptParent).toEqual({ from: 'mid', to: 'top' })
    expect(plan.reparent).toEqual([{ unitId: 'mid', from: 'a' }])
  })
})

describe('ready-made structures (org.js ORG_TPL)', () => {
  const unit = (id: string, extra: Partial<ReadyMadeUnit> = {}): ReadyMadeUnit => ({ id, code: id.toUpperCase(), name: `Unit ${id}`, parentId: null, takesOrders: true, closed: false, mergedIntoId: null, areaId: null, members: [], openOrders: 0, ...extra })
  const facts = (units: ReadyMadeUnit[]): ReadyMadeFacts => ({
    siteName: 'Made-up Plant A1',
    units,
    areas: [
      { id: 'sew', code: 'SEW-HALL', name: 'Sewing hall', sortOrder: 1 },
      { id: 'cut', code: 'CUT-ROOM', name: 'Cutting room', sortOrder: 2 },
    ],
  })
  const fresh = facts([unit('t1', { areaId: 'sew' }), unit('t2', { areaId: 'cut' }), unit('t3'), unit('quality', { takesOrders: false }), unit('kept', { parentId: 'quality' })])
  const summary = (plan: ReturnType<typeof readyMadePreview>) => plan.changes.map((change) => `${change.change} ${change.code} → ${change.parentCode ?? 'top'}`)

  it('the owner and the teams: the top unit, every unit at the top under it; a unit put under the owner’s own unit stays', () => {
    const plan = readyMadePreview('OWNER_TEAMS', fresh)
    expect(plan.blockers).toEqual([])
    expect(summary(plan)).toEqual(['MAKE RM-TOP → top', 'MOVE T1 → RM-TOP', 'MOVE T2 → RM-TOP', 'MOVE T3 → RM-TOP', 'MOVE QUALITY → RM-TOP'])
    expect(plan.changes[0]).toMatchObject({ name: 'Made-up Plant A1', kindWord: 'Company', unitId: null })
  })

  it('with supervisors: one group per area of the teams’ lines (and "Floor"), the services beside them under the top', () => {
    const plan = readyMadePreview('SUPERVISORS', fresh)
    expect(summary(plan)).toEqual([
      'MAKE RM-TOP → top',
      `MAKE ${groupCodeOf('SEW-HALL')} → RM-TOP`,
      `MAKE ${groupCodeOf('CUT-ROOM')} → RM-TOP`,
      'MAKE RM-FLOOR → RM-TOP',
      `MOVE T1 → ${groupCodeOf('SEW-HALL')}`,
      `MOVE T2 → ${groupCodeOf('CUT-ROOM')}`,
      'MOVE T3 → RM-FLOOR',
      'MOVE QUALITY → RM-TOP',
    ])
    expect(plan.changes[1]).toMatchObject({ name: 'Sewing hall', kindWord: 'Group' })
  })

  it('with a general manager: top → general management → groups → teams; back to the simple one closes the levels and takes their people out', () => {
    const plan = readyMadePreview('GENERAL_MANAGER', fresh)
    expect(summary(plan).slice(0, 2)).toEqual(['MAKE RM-TOP → top', 'MAKE RM-GM → RM-TOP'])
    expect(summary(plan)).toContain('MOVE QUALITY → RM-GM')

    // As it stands after the general manager one: the levels exist, Gina (made up) leads the general management.
    const applied = facts([
      unit('top', { code: 'RM-TOP', name: 'Made-up Plant A1', takesOrders: false }),
      unit('gm', { code: 'RM-GM', name: 'General management', parentId: 'top', takesOrders: false, members: [{ employeeId: 'gina', name: 'Gina General-manager' }] }),
      unit('g1', { code: groupCodeOf('SEW-HALL'), name: 'Sewing hall', parentId: 'gm', takesOrders: false }),
      unit('t1', { areaId: 'sew', parentId: 'g1' }),
      unit('quality', { takesOrders: false, parentId: 'gm' }),
    ])
    const back = readyMadePreview('OWNER_TEAMS', applied)
    expect(summary(back)).toEqual(['MOVE T1 → RM-TOP', 'MOVE QUALITY → RM-TOP', `CLOSE RM-GM → top`, `CLOSE ${groupCodeOf('SEW-HALL')} → top`])
    expect(back.changes.find((change) => change.code === 'RM-GM')!.peopleOut).toEqual([{ employeeId: 'gina', name: 'Gina General-manager' }])
    // Nothing changes when the levels are like this already.
    expect(readyMadePreview('GENERAL_MANAGER', applied).changes).toEqual([])
  })

  it('opens a closed ready-made unit again (its code is taken) and refuses while a level to close has open orders', () => {
    const closedTop = facts([unit('top', { code: 'RM-TOP', name: 'Our plant', closed: true }), unit('t1')])
    expect(summary(readyMadePreview('OWNER_TEAMS', closedTop))).toEqual(['REOPEN RM-TOP → top', 'MOVE T1 → RM-TOP'])
    const busy = facts([unit('top', { code: 'RM-TOP', takesOrders: false }), unit('gm', { code: 'RM-GM', parentId: 'top', openOrders: 2 })])
    expect(readyMadePreview('OWNER_TEAMS', busy).blockers).toEqual([{ name: 'Unit gm', code: 'READY_MADE_BLOCKED', words: 'Unit gm has 2 open orders: give them to another team first.' }])
    expect(readyMadeRows(readyMadePreview('OWNER_TEAMS', busy))).toEqual([{ name: 'Unit gm', words: 'Unit gm has 2 open orders: give them to another team first.' }])
  })

  it('the preview says one line a unit, in words: made, opened again, moved, closed with its people out', () => {
    expect(readyMadeRows(readyMadePreview('OWNER_TEAMS', fresh)).slice(0, 2)).toEqual([
      { name: 'Made-up Plant A1', words: 'Is made, at the top' },
      { name: 'Unit t1', words: 'Moves under Made-up Plant A1 (was at the top)' },
    ])
    const applied = facts([
      unit('top', { code: 'RM-TOP', name: 'Made-up Plant A1', takesOrders: false }),
      unit('gm', { code: 'RM-GM', name: 'General management', parentId: 'top', takesOrders: false, members: [{ employeeId: 'gina', name: 'Gina General-manager' }] }),
      unit('quality', { takesOrders: false, parentId: 'gm' }),
    ])
    expect(readyMadeRows(readyMadePreview('OWNER_TEAMS', applied))).toEqual([
      { name: 'Unit quality', words: 'Moves under Made-up Plant A1 (was under General management)' },
      { name: 'General management', words: 'Leaves the chart (closed); Gina General-manager waits in “In no unit yet”' },
    ])
    expect(readyMadeRows(readyMadePreview('GENERAL_MANAGER', applied))).toEqual([])
  })
})

describe('the History tab (design § 5zb "Control")', () => {
  const names: HistoryNames = {
    actors: new Map([['u1', 'Otto Owner (made up)']]),
    employees: new Map([
      ['e1', 'Noor Worker'],
      ['e2', 'Tariq Leader'],
    ]),
    units: new Map([['t1', 'Team Noor']]),
  }
  const audit = (action: string, extra: Partial<HistoryAudit> = {}): HistoryAudit => ({ id: action, at: '2026-11-28T09:00:00.000Z', audience: 'OFFICE', actorId: 'u1', action, recordType: 'Team', recordId: 't1', before: null, after: null, ...extra })

  it('says each change of a unit in words with one icon and who; a save without a change says nothing; no customer is named', () => {
    const rows = historyRows(
      [
        audit('people.units.merge', { after: { name: 'Team Noor', merged: [{ id: 't2', name: 'Team Tariq' }], people: 3, orders: 2, units: 0 } }),
        audit('people.units.update', { before: { worksForPartyIds: [] }, after: { worksForPartyIds: ['party-1'], maxBaskets: 12 } }),
        audit('people.units.update', { after: { unchanged: true } }),
        audit('people.units.move', { before: { parentName: null }, after: { parentName: 'Floor A' } }),
        audit('people.setTeamLead', { before: { leadEmployeeId: null }, after: { leadEmployeeId: 'e2' } }),
        audit('people.units.close', { audience: 'SYSTEM' }),
      ],
      { kind: 'UNIT', unitId: 't1', unitCode: 'T1' },
      names,
    )
    expect(rows.map((row) => [row.words, row.icon, row.who])).toEqual([
      ['Team Tariq became one with it: 3 people, 2 open orders, 0 units moved here', 'merge', 'Otto Owner (made up)'],
      ['Profile changed: the customers it works for, baskets at one time', 'pencil', 'Otto Owner (made up)'],
      ['Moved under Floor A (was at the top)', 'move', 'Otto Owner (made up)'],
      ['Leader: nobody → Tariq Leader', 'crown', 'Otto Owner (made up)'],
      ['Closed', 'archive', 'System'],
    ])
    expect(JSON.stringify(rows)).not.toContain('party-1')
  })

  it('says a person’s moves, loans and role changes, and the team rows that name them', () => {
    const rows = historyRows(
      [
        audit('people.units.merge', { recordType: 'Employee', recordId: 'e1', after: { from: { id: 't2', name: 'Team Tariq' }, to: { id: 't1', name: 'Team Noor' }, wasLeader: false } }),
        audit('people.updateEmployee', { recordType: 'Employee', recordId: 'e1', before: { jobRole: 'Worker', locale: 'it', firstName: 'Noor', lastName: 'Worker', displayName: 'Noor W.' }, after: { jobRole: 'Team leader', locale: 'ur', firstName: 'Noor', lastName: 'Worker', displayName: 'Noor W.' } }),
        audit('people.lendToLine', { recordType: 'Employee', recordId: 'e1', after: { endsAt: '2026-12-03T17:00:00.000Z' } }),
        audit('people.moveTeamMembers', { after: { moved: [{ employeeId: 'e1', from: 'T2', to: 'T1' }, { employeeId: 'e2', from: null, to: 'T1' }] } }),
        audit('people.setTeamLead', { before: { leadEmployeeId: null }, after: { leadEmployeeId: 'e1' } }),
        audit('people.setTeamLead', { before: { leadEmployeeId: 'e2' }, after: { leadEmployeeId: null } }),
      ],
      { kind: 'PERSON', employeeId: 'e1' },
      names,
    )
    expect(rows.map((row) => row.words)).toEqual([
      'Moved to Team Noor (the units were merged; was in Team Tariq)',
      'Role: Worker → Team leader · Reads and speaks: it → ur',
      'Lent to another line until 2026-12-03',
      'Moved from team T2 to team T1',
      'Leads Team Noor',
    ])
  })
})
