import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { ownLettersOf, pictureOf } from '../../../lib/people-picture/model'
import { pictureSchema, sourceOfPicture } from '../../../lib/people-picture/schema'
import { BOARD, BY_RULE_SALES, designScreen, KIAN, LIA, NO_TEAM, NOOR, PEOPLE, SPLIT_PRINTED, TOGETHER } from './fixtures'
import { designScreen as partScreen } from './parts/fixtures'
import {
  addTeam,
  askHeldOf,
  boardModelOf,
  candidatesOf,
  canSplitOf,
  evenShares,
  filterColumns,
  giveDraftOf,
  giveHeldOf,
  lastDayOf,
  lendBodyOf,
  lendDraftOf,
  lendHeldOf,
  lendMaxDayOf,
  lendProblemOf,
  lendTeamsOf,
  loadOf,
  marksOf,
  modeNoteOf,
  partModelOf,
  peopleByTeamOf,
  problemKeyOf,
  putBodyOf,
  putInCharge,
  removeTeam,
  rowFactsOf,
  setMode,
  setShare,
  shareEvenly,
  splitHeldOf,
  startedEmpty,
  sumLineOf,
  teamsAnswerOf,
  teamsRightsOf,
} from './model'
import { OrderTeamPartView } from './view/OrderTeamPartView'
import { TeamsBoardView } from './view/TeamsBoardView'

/**
 * owb-ss7 (S3 web B; design plan § 5za, § 5zd, § 5ze) — Production › Teams (7.1), "Give to a team…" and "Lend a person" (7.2), the
 * order's Team part (7.3). Written, not run (Owner rule: checks at the end). Made-up data (fixtures.ts).
 */

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const apiError = (kind: string, issues: { path: string }[] = []) => ({ kind, issues })

describe('7.1 the Teams page — the board model', () => {
  const board = boardModelOf(BOARD, PEOPLE)

  it('"No team yet" first, then the teams in the API\'s order; counts: teams, orders with a team (each once), orders with none', () => {
    expect(board.columns.map((column) => column.key)).toEqual(['none', NOOR.id, KIAN.id, LIA.id])
    expect(board.teams).toBe(3)
    expect(board.withTeam).toBe(4) // order-100 is on two teams: counted once
    expect(board.noTeam).toBe(1)
  })

  it('a board with no "No team yet" column still draws it first, empty', () => {
    const only = boardModelOf({ ...BOARD, columns: BOARD.columns.filter((column) => column.team !== null) }, null)
    expect(only.columns[0]).toMatchObject({ key: 'none', team: null, cards: [] })
    expect(only.noTeam).toBe(0)
  })

  it('null figures: a small team shows "—" (no number of its own), a team with a limit "n of max", without one "n"', () => {
    expect(board.columns.find((column) => column.key === LIA.id)!.load).toEqual({ kind: 'small' })
    expect(board.columns.find((column) => column.key === NOOR.id)!.load).toEqual({ kind: 'of', inWork: 9, max: 12 })
    expect(loadOf({ inWork: 3, maxBaskets: null })).toEqual({ kind: 'count', inWork: 3 })
    // Privacy: Team Lia's card is late, but the API sent no LATE mark: the page never counts one itself.
    expect(board.columns.find((column) => column.key === LIA.id)!.marks.map((mark) => mark.code)).toEqual(['NO_NEW_ORDERS'])
  })

  it('marks: known codes once each, a number after ":", aliases read as one, unknown codes and zero counts left out', () => {
    expect(marksOf(['LATE:1', 'OVER_LIMIT', 'SOMETHING_NEW'])).toEqual([
      { code: 'OVER_LIMIT', count: null },
      { code: 'LATE', count: 1 },
    ])
    expect(marksOf(['missing_today:2', 'MISSING_TODAY'])).toEqual([{ code: 'MISSING_TODAY', count: 2 }])
    expect(marksOf(['TAKES_NO_NEW_ORDER', 'PAUSED'])).toEqual([{ code: 'NO_NEW_ORDERS', count: null }])
    expect(marksOf(['MISSING_TODAY:0'])).toEqual([])
  })

  it('"In charge" only on an order that several teams make', () => {
    const noor = board.columns.find((column) => column.key === NOOR.id)!
    expect(noor.cards.find((card) => card.orderId === 'order-100')!.inCharge).toBe(true)
    expect(noor.cards.find((card) => card.orderId === 'order-104')!.inCharge).toBe(false)
    expect(board.columns.find((column) => column.key === LIA.id)!.cards[0]!.inCharge).toBe(false)
  })

  it('people: the leader first; without people.view no chips (null), with it each team its members and its line', () => {
    expect(board.columns.find((column) => column.key === NOOR.id)!.people!.map((member) => member.name)).toEqual(['Noor Nadir', 'Omar Ortis', 'Petra Pane'])
    expect(board.columns.find((column) => column.key === LIA.id)!.lineId).toBeNull()
    expect(boardModelOf(BOARD, null).columns.every((column) => column.people === null)).toBe(true)
    expect(peopleByTeamOf(null)).toBeNull()
  })

  it('the phone\'s filter: all, No team yet, one team; a team that is gone shows every column', () => {
    expect(filterColumns(board.columns, 'all')).toHaveLength(4)
    expect(filterColumns(board.columns, 'none').map((column) => column.key)).toEqual(['none'])
    expect(filterColumns(board.columns, KIAN.id).map((column) => column.key)).toEqual([KIAN.id])
    expect(filterColumns(board.columns, 'team-gone')).toHaveLength(4)
  })

  it('rights from the session: give = production.teams.assign, lend = people.loans.manage, new team = people.structure.manage', () => {
    expect(teamsRightsOf(['workorders.view', 'orders.view'])).toEqual({ give: false, lend: false, newTeam: false, people: false })
    expect(teamsRightsOf(['production.teams.assign', 'people.loans.manage', 'people.structure.manage', 'people.view'])).toEqual({ give: true, lend: true, newTeam: true, people: true })
  })
})

describe('7.1 the Teams page — what a reader sees', () => {
  const html = (id: string) => render(createElement(TeamsBoardView, { model: designScreen.cases.find((item) => item.id === id)!.model }))

  it('the production manager: the columns, the customer CODE (never a name), "—" with "Small teams show no numbers", marks in words', () => {
    const page = html('manager')
    const text = textOf(page)
    expect(text).toContain('No team yet')
    expect(text).toContain('Team Noor')
    expect(text).toContain('9 of 12 baskets')
    expect(text).toContain('2 missing today')
    expect(text).toContain('Over its limit')
    expect(text).toContain('1 late')
    expect(text).toContain('Takes no new order')
    expect(text).toContain('C-ALPHA')
    expect(page).toContain('aria-label="Small teams show no numbers."')
    expect(text).not.toContain('SOMETHING_NEW')
    expect(text).toContain('Give to a team…')
    expect(text).toContain('Change…')
    expect(text).toContain('New team…')
    expect(page).toContain('/w/demo/sales/orders/order-104?tab=production')
    expect(page).toContain('aria-label="Lend Omar Ortis…"')
    expect(page).not.toContain('aria-label="Lend Noor Nadir…"') // the leader is not lent from the board
  })

  it('sales reads: no Give, no New team, no lend, "You read this page"', () => {
    const text = textOf(html('sales'))
    expect(text).toContain('You read this page')
    expect(text).not.toContain('Give to a team…')
    expect(text).not.toContain('New team…')
    expect(html('sales')).not.toContain('Lend ')
  })

  it('"All sites" with several: the page asks for the site; failed: the words and Try again', () => {
    expect(textOf(html('site'))).toContain('Teams work on one site. Choose the site:')
    expect(textOf(html('failed'))).toContain('Try again')
  })

  it('every case draws in Italian too, with no key left on screen', () => {
    for (const item of designScreen.cases) {
      const text = textOf(render(createElement(TeamsBoardView, { model: item.model }), 'it'))
      expect(text, item.id).not.toMatch(/\b(head|column|load|mark|card|people|site|filter|error|notice)\.[A-Za-z]/)
    }
  })
})

describe('7.2 "Give to a team…" — the window model', () => {
  it('the draft from the read: rows, ONE in charge, together or split, the start (Save waits while nothing changed)', () => {
    const draft = giveDraftOf(TOGETHER)
    expect(draft.rows.map((row) => row.teamId)).toEqual([NOOR.id, KIAN.id])
    expect(draft.mode).toBe('TOGETHER')
    expect(draft.inCharge).toBe(NOOR.id)
    expect(giveHeldOf(draft)).toEqual({ key: 'give.held.unchanged' })
    expect(giveDraftOf(SPLIT_PRINTED).mode).toBe('SPLIT')
  })

  it('add / take off / put in charge: a team once, the first team in charge, in charge moves when its team goes', () => {
    let draft = giveDraftOf(NO_TEAM)
    expect(startedEmpty(draft)).toBe(true)
    expect(giveHeldOf(draft)).toEqual({ key: 'give.held.addTeam' })
    draft = addTeam(draft, KIAN.id)
    expect(draft.inCharge).toBe(KIAN.id)
    expect(addTeam(draft, KIAN.id).rows).toHaveLength(1)
    draft = addTeam(draft, NOOR.id)
    draft = putInCharge(draft, NOOR.id)
    expect(draft.inCharge).toBe(NOOR.id)
    expect(putInCharge(draft, 'team-gone').inCharge).toBe(NOOR.id)
    draft = removeTeam(draft, NOOR.id)
    expect(draft.inCharge).toBe(KIAN.id)
    expect(giveHeldOf(draft)).toBeNull()
    expect(putBodyOf(draft)).toEqual({ version: 1, rows: [{ teamId: KIAN.id, inCharge: true, basketShare: null }] })
  })

  it('even split: 12 over 5 → 3 3 2 2 2; 12 over 2 → 6 6; nothing over none', () => {
    expect(evenShares(12, 5)).toEqual([3, 3, 2, 2, 2])
    expect(evenShares(12, 2)).toEqual([6, 6])
    expect(evenShares(5, 0)).toEqual([])
  })

  it('split: shared evenly when chosen, the line "n of 12 baskets are given", held while they do not add up or a share is 0', () => {
    let draft = setMode(giveDraftOf(TOGETHER), 'SPLIT')
    expect(draft.rows.map((row) => row.share)).toEqual([6, 6])
    expect(sumLineOf(draft)).toEqual({ state: 'ok', words: { key: 'give.sum.ok', params: { given: 12, planned: 12 } } })
    expect(giveHeldOf(draft)).toBeNull()
    draft = setShare(draft, NOOR.id, 9)
    expect(sumLineOf(draft)!.state).toBe('over')
    expect(giveHeldOf(draft)).toEqual({ key: 'give.held.notAddUp', params: { given: 15, planned: 12 } })
    draft = setShare(draft, KIAN.id, 0)
    expect(giveHeldOf(draft)).toEqual({ key: 'give.held.shareZero' })
    draft = setShare(draft, KIAN.id, 1)
    expect(sumLineOf(draft)).toMatchObject({ state: 'short', words: { params: { count: 2 } } })
    draft = shareEvenly(draft)
    expect(draft.rows.map((row) => row.share)).toEqual([6, 6])
    expect(setShare(draft, NOOR.id, 99).rows[0]!.share).toBe(12) // never more than the planned baskets
    expect(putBodyOf(draft).rows.map((row) => row.basketShare)).toEqual([6, 6])
  })

  it('adding a team to a split shares again; under two teams they work together; back to together drops the shares', () => {
    let draft = setMode(giveDraftOf(TOGETHER), 'SPLIT')
    draft = addTeam(draft, LIA.id)
    expect(draft.rows.map((row) => row.share)).toEqual([4, 4, 4])
    draft = removeTeam(removeTeam(draft, LIA.id), KIAN.id)
    expect(draft.mode).toBe('TOGETHER')
    expect(draft.rows[0]!.share).toBeNull()
    expect(setMode(setMode(giveDraftOf(TOGETHER), 'SPLIT'), 'TOGETHER').rows.every((row) => row.share === null)).toBe(true)
  })

  it('split is held with words: one team, more teams than baskets, after the print', () => {
    expect(splitHeldOf(giveDraftOf({ ...NO_TEAM, rows: [TOGETHER.rows[0]!] }))).toEqual({ key: 'give.held.splitTwo' })
    const tiny = giveDraftOf({ ...TOGETHER, plannedBaskets: 1 })
    expect(canSplitOf(tiny)).toBe(false)
    expect(splitHeldOf(tiny)).toEqual({ key: 'give.held.splitTooFew', params: { count: 1, teams: 2 } })
    expect(setMode(tiny, 'SPLIT').mode).toBe('TOGETHER')
    expect(splitHeldOf(giveDraftOf(SPLIT_PRINTED))).toEqual({ key: 'give.held.sharedAtPrint' })
  })

  it('after the print: the shares stay (read only), a split row cannot be taken off, a team added works with every basket', () => {
    let draft = giveDraftOf(SPLIT_PRINTED)
    expect(draft.rows.every((row) => row.locked)).toBe(true)
    expect(removeTeam(draft, KIAN.id).rows).toHaveLength(2)
    expect(setShare(draft, NOOR.id, 3).rows[0]!.share).toBe(7)
    expect(setMode(draft, 'TOGETHER').mode).toBe('SPLIT')
    expect(shareEvenly(draft)).toBe(draft)
    expect(sumLineOf(draft)).toBeNull()
    expect(modeNoteOf(draft)).toEqual({ key: 'give.note.sharedAtPrint' })
    draft = addTeam(draft, LIA.id)
    expect(draft.rows[2]).toEqual({ teamId: LIA.id, share: null, locked: false })
    expect(giveHeldOf(draft)).toBeNull()
    expect(putBodyOf(draft).rows).toEqual([
      { teamId: NOOR.id, inCharge: true, basketShare: 7 },
      { teamId: KIAN.id, inCharge: false, basketShare: 5 },
      { teamId: LIA.id, inCharge: false, basketShare: null },
    ])
    expect(removeTeam(draft, LIA.id).rows).toHaveLength(2)
  })

  it('taking every team off an order that had teams: allowed, and said ("every worker sees its baskets")', () => {
    const draft = removeTeam(removeTeam(giveDraftOf(TOGETHER), NOOR.id), KIAN.id)
    expect(giveHeldOf(draft)).toBeNull()
    expect(modeNoteOf(draft)).toEqual({ key: 'give.note.noTeam' })
    expect(putBodyOf(draft).rows).toEqual([])
  })

  it('the why goes with the save only when typed', () => {
    const draft = { ...addTeam(giveDraftOf(NO_TEAM), NOOR.id), why: '  a big order ' }
    expect(putBodyOf(draft)).toEqual({ version: 1, rows: [{ teamId: NOOR.id, inCharge: true, basketShare: null }], why: 'a big order' })
  })

  it('"Add a team": the teams not on the order, the suggested one first (worked for this customer, takes new orders), the search', () => {
    // order-107 is C-ALPHA's; Team Noor has another C-ALPHA order (order-104): suggested.
    const draft = giveDraftOf(NO_TEAM)
    const list = candidatesOf(draft, BOARD, '')
    expect(list.map((candidate) => [candidate.facts.face.id, candidate.suggested])).toEqual([
      [NOOR.id, true],
      [KIAN.id, false],
      [LIA.id, false],
    ])
    expect(list[0]!.facts.workedForCustomer).toBe(true)
    expect(candidatesOf(draft, BOARD, 'kian').map((candidate) => candidate.facts.face.id)).toEqual([KIAN.id])
    expect(candidatesOf(draft, BOARD, 'TÉAM lía').map((candidate) => candidate.facts.face.id)).toEqual([LIA.id])
    expect(candidatesOf(draft, null, '')).toEqual([])
  })

  it('a team that takes no new order is never suggested, but it stays in the list with its mark', () => {
    // order-105 is C-BETA's; only Team Lia (takes no new order) and Noor/Kian (order-100, C-BETA) worked for C-BETA.
    const draft = giveDraftOf({ ...NO_TEAM, orderId: 'order-105' })
    const list = candidatesOf(draft, BOARD, '')
    expect(list.find((candidate) => candidate.suggested)!.facts.face.id).toBe(NOOR.id)
    const lia = list.find((candidate) => candidate.facts.face.id === LIA.id)!
    expect(lia.suggested).toBe(false)
    expect(lia.facts.takesNewOrders).toBe(false)
  })

  it('row facts: the read\'s for a team on the order, the board\'s for one added in the window (null figures stay null)', () => {
    const draft = addTeam(giveDraftOf(TOGETHER), LIA.id)
    const facts = rowFactsOf(draft, TOGETHER, BOARD)
    expect(facts.get(NOOR.id)).toMatchObject({ workedForCustomer: true, missingToday: 2, load: { kind: 'of', inWork: 9, max: 12 } })
    expect(facts.get(LIA.id)).toMatchObject({ load: { kind: 'small' }, people: null, takesNewOrders: false })
  })
})

describe('7.2 "Lend a person" — the window model', () => {
  const today = '2026-11-28'

  it('the last day: Today · 3 days · A week · a day picked; at most 31 days (today counts)', () => {
    expect(lastDayOf('TODAY', today, '')).toBe('2026-11-28')
    expect(lastDayOf('THREE_DAYS', today, '')).toBe('2026-11-30')
    expect(lastDayOf('WEEK', today, '')).toBe('2026-12-04')
    expect(lastDayOf('DAY', today, '2026-12-20')).toBe('2026-12-20')
    expect(lastDayOf('DAY', today, '')).toBeNull()
    expect(lendMaxDayOf(today)).toBe('2026-12-28')
  })

  it('held with words: no team, a team with no line (L9), a day out of range, no reason, a long reason', () => {
    const draft = lendDraftOf({ employeeId: 'emp-omar', name: 'Omar Ortis' }, NOOR.id)
    expect(lendHeldOf(draft, null, today)).toEqual({ key: 'lend.held.team' })
    expect(lendHeldOf({ ...draft, toTeamId: LIA.id }, null, today)).toEqual({ key: 'lend.held.noLine' })
    expect(lendHeldOf({ ...draft, toTeamId: KIAN.id, until: 'DAY', picked: '2026-12-29' }, 'line-b', today)).toEqual({ key: 'lend.held.day', params: { count: 31 } })
    expect(lendHeldOf({ ...draft, toTeamId: KIAN.id, until: 'DAY', picked: '2026-11-27' }, 'line-b', today)).toEqual({ key: 'lend.held.day', params: { count: 31 } })
    expect(lendHeldOf({ ...draft, toTeamId: KIAN.id }, 'line-b', today)).toEqual({ key: 'lend.held.reason' })
    expect(lendHeldOf({ ...draft, toTeamId: KIAN.id, reason: 'x'.repeat(301) }, 'line-b', today)).toEqual({ key: 'lend.held.reasonLong', params: { count: 300 } })
    expect(lendHeldOf({ ...draft, toTeamId: KIAN.id, until: 'WEEK', reason: 'a big order' }, 'line-b', today)).toBeNull()
  })

  it('the body of today\'s loans API: the team\'s line, the team, from now to the end of the last day, the reason', () => {
    const draft = { ...lendDraftOf({ employeeId: 'emp-omar', name: 'Omar Ortis' }, NOOR.id), toTeamId: KIAN.id, until: 'THREE_DAYS' as const, reason: ' a big order ' }
    expect(lendBodyOf(draft, 'line-b', today, '2026-11-28T09:15:00.000Z', (day) => `${day}T22:59:00.000Z`)).toEqual({
      employeeId: 'emp-omar',
      toLineId: 'line-b',
      toTeamId: KIAN.id,
      startsAt: '2026-11-28T09:15:00.000Z',
      endsAt: '2026-11-30T22:59:00.000Z',
      reason: 'a big order',
    })
  })

  it('the home team is never offered; refusals in words from today\'s codes', () => {
    expect(lendTeamsOf({ homeTeamId: NOOR.id }, BOARD).map((team) => team.id)).toEqual([KIAN.id, LIA.id])
    expect(lendProblemOf(apiError('conflict', [{ path: 'refusal/LOAN_OVERLAP' }]))).toBe('lend.refusal.LOAN_OVERLAP')
    expect(lendProblemOf(apiError('conflict', [{ path: 'refusal/TEAM_NO_LINE' }]))).toBe('lend.held.noLine')
    expect(lendProblemOf(apiError('conflict', [{ path: 'refusal/SOMETHING' }]))).toBe('error.conflict')
    expect(lendProblemOf(apiError('forbidden'))).toBe('error.forbidden')
  })
})

describe('7.3 the order\'s Team part — per right, and after the print', () => {
  it('the production manager: no team → Give to a team…; teams → Change…', () => {
    expect(partModelOf(NO_TEAM, false)).toMatchObject({ empty: true, button: 'GIVE', answer: { key: 'part.none' } })
    expect(partModelOf(TOGETHER, false)).toMatchObject({ empty: false, button: 'CHANGE', answer: { key: 'part.together', params: { teams: 'Team Noor + Team Kian', team: 'Team Noor' } } })
  })

  it('sales: Ask for another team, then "Asked"; given by its order structure says so', () => {
    expect(partModelOf(BY_RULE_SALES, false)).toMatchObject({ button: 'ASK', byRule: true, answer: { key: 'part.one', params: { team: 'Team Kian' } } })
    expect(partModelOf(BY_RULE_SALES, true).button).toBe('ASKED')
  })

  it('a person with neither right has no button', () => {
    expect(partModelOf({ ...TOGETHER, may: { give: false, ask: false } }, false).button).toBeNull()
  })

  it('in charge is said only when teams work together; a split says each team\'s baskets; before the print they are "to come"', () => {
    expect(partModelOf(TOGETHER, false).chips.map((chip) => chip.inCharge)).toEqual([true, false])
    expect(partModelOf(SPLIT_PRINTED, false).chips.map((chip) => [chip.inCharge, chip.share])).toEqual([
      [false, 7],
      [false, 5],
    ])
    expect(teamsAnswerOf(SPLIT_PRINTED)).toEqual({ key: 'part.split', params: { teams: 'Team Noor: 7 · Team Kian: 5' } })
    expect(teamsAnswerOf({ ...SPLIT_PRINTED, printed: false })).toMatchObject({ key: 'part.splitSoon' })
    expect(partModelOf(SPLIT_PRINTED, false).soon).toBe(false)
    expect(partModelOf(TOGETHER, false).soon).toBe(true)
  })

  it('the ask: why is needed, at most 300 characters', () => {
    expect(askHeldOf('  ')).toEqual({ key: 'ask.held.why' })
    expect(askHeldOf('x'.repeat(301))).toEqual({ key: 'ask.held.long', params: { count: 300 } })
    expect(askHeldOf('the customer asked for Team Noor')).toBeNull()
  })

  it('the part as drawn: the team chips, the one button, the answer, in both languages, no key left', () => {
    for (const item of partScreen.cases) {
      for (const locale of ['en', 'it'] as const) {
        const text = textOf(render(createElement(OrderTeamPartView, { model: item.model }), locale))
        expect(text, `${item.id} ${locale}`).not.toMatch(/\b(part|give|ask|error|common)\.[A-Za-z]/)
      }
    }
    const together = textOf(render(createElement(OrderTeamPartView, { model: partScreen.cases.find((item) => item.id === 'manager-together')!.model })))
    expect(together).toContain('Team Noor')
    expect(together).toContain('In charge')
    expect(together).toContain('Change…')
    const asked = textOf(render(createElement(OrderTeamPartView, { model: partScreen.cases.find((item) => item.id === 'sales-asked')!.model })))
    expect(asked).toContain('Asked: the production manager answers.')
    expect(asked).not.toContain('Ask for another team')
  })
})

describe('walls and seams', () => {
  it('a part another page mounts: no session → nothing drawn; no right (403) or no route (404) → no part, no error line', () => {
    const part = source('./parts/OrderTeamPart.tsx')
    expect(part).toContain('const office = useOfficeOrNull()')
    expect(part).toContain('if (!office) return null')
    expect(part).toContain("hidden: problem === 'error.forbidden' || problem === 'error.notFound'")
    expect(problemKeyOf(apiError('forbidden'), false)).toBe('error.forbidden')
    expect(problemKeyOf(apiError('not_found'), false)).toBe('error.notFound')
    expect(problemKeyOf(apiError('conflict'), true)).toBe('error.conflict')
  })

  it('the base\'s slot keeps its export name, props and owner line', () => {
    const part = source('./parts/OrderTeamPart.tsx')
    expect(part).toContain('SLOT — owner: S3 (owb-ss7)')
    expect(part).toContain('export function OrderTeamPart(')
    expect(part).toContain('export interface OrderTeamPartProps {')
    expect(part).toContain('readonly companyId: string')
    expect(part).toContain('readonly orderId: string')
  })

  it('the customer never sees a team: no portal file reads these routes; the board shows customer codes, never a customer name', () => {
    expect(source('./api.ts')).not.toMatch(/customerName|partyName/)
    expect(source('./view/TeamsBoardView.tsx')).toContain('card.customerCode')
  })

  it('no figure about one person: the people chips carry names only, a team\'s figures come from the API', () => {
    const view = source('./view/TeamsBoardView.tsx')
    expect(view).not.toMatch(/member\.(count|baskets|speed|done|rank)/)
    expect(source('./model.ts')).not.toMatch(/\.filter\(\(order\) => order\.late\)\.length/)
  })

  it('the API picture: letters, 12 icons, 10 tones; an unknown kind reads as letters; the API\'s letters win when they are 1–2 letters', () => {
    expect(pictureSchema.parse({ kind: 'PHOTO', icon: 'scissors', colour: 'orange', letters: 'TN' }).kind).toBe('LETTERS')
    expect(pictureOf(sourceOfPicture('Team Noor', { kind: 'ICON', icon: 'scissors', colour: 'orange', letters: 'TN' }, 'team'))).toMatchObject({ look: 'icon', icon: 'scissors', tone: 'orange', who: 'team' })
    expect(pictureOf(sourceOfPicture('Dora Campione', { kind: 'LETTERS', icon: null, colour: null, letters: 'dx' }, 'person')).letters).toBe('DX')
    expect(ownLettersOf('ABC')).toBeNull()
    expect(ownLettersOf('#')).toBeNull()
    expect(pictureOf(sourceOfPicture('Dora Campione', null, 'person')).letters).toBe('DC')
  })

  it('the words: teams-board and order-teams have the same keys in en and it', () => {
    for (const namespace of ['teams-board', 'order-teams']) {
      const en = Object.keys(CATALOGUE.en[namespace] ?? {}).sort()
      const it = Object.keys(CATALOGUE.it[namespace] ?? {}).sort()
      expect(en.length, namespace).toBeGreaterThan(20)
      expect(it, namespace).toEqual(en)
    }
  })

  it('the page replaces the base\'s stub and the window speaks through the window shell', () => {
    expect(source('../../../app/(office)/w/[company]/production/teams/page.tsx')).toContain('<TeamsPage />')
    for (const file of ['./view/GiveTeamsWindow.tsx', './view/LendWindow.tsx', './view/AskTeamWindow.tsx']) expect(source(file), file).toContain('<WindowShell')
  })
})
