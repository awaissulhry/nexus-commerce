import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OrderTeams, TeamFace, TeamsBoard } from './api'
import { boardModelOf, teamsRightsOf, type TeamPeople } from './model'
import { TeamsBoardView, type TeamsBoardViewModel } from './view/TeamsBoardView'

/**
 * owb-ss7 — Production › Teams with made-up data (design index `/design/SCR-owb-teams`): three teams (one of 2 people: the API sends no
 * figure, the page shows "—"), the column "No team yet", an order two teams make together, the marks, the people of each team, and the
 * page as sales reads it. The tests read the same data. Made-up names, codes and numbers only; customer CODES, never a name.
 */

const PREFIX = '/w/demo'
const face = (id: string, name: string, picture: TeamFace['picture'], leader: TeamFace['leader'], people: number | null): TeamFace => ({ id, name, picture, leader, people })

export const NOOR = face('team-noor', 'Team Noor', { kind: 'ICON', icon: 'scissors', colour: 'orange', letters: 'TN' }, { employeeId: 'emp-noor', name: 'Noor Nadir' }, 6)
export const KIAN = face('team-kian', 'Team Kian', { kind: 'ICON', icon: 'shirt', colour: 'cyan', letters: 'TK' }, { employeeId: 'emp-kian', name: 'Kian Kole' }, 4)
/** A team of 2 people: below the minimum group, the API sends null for every figure. */
export const LIA = face('team-lia', 'Team Lia', { kind: 'LETTERS', icon: null, colour: 'violet', letters: 'TL' }, null, null)

export const BOARD: TeamsBoard = {
  columns: [
    { team: null, load: { inWork: null, maxBaskets: null }, marks: [], orders: [{ orderId: 'order-107', number: 'SO-2026-0107', customerCode: 'C-ALPHA', baskets: 8, inCharge: false, due: '2026-12-09', late: false }] },
    {
      team: NOOR,
      load: { inWork: 9, maxBaskets: 12 },
      marks: ['MISSING_TODAY:2'],
      orders: [
        { orderId: 'order-104', number: 'SO-2026-0104', customerCode: 'C-ALPHA', baskets: 6, inCharge: true, due: '2026-12-05', late: false },
        { orderId: 'order-100', number: 'SO-2026-0100', customerCode: 'C-BETA', baskets: 6, inCharge: true, due: '2026-12-01', late: true },
      ],
    },
    {
      team: KIAN,
      load: { inWork: 14, maxBaskets: 12 },
      marks: ['OVER_LIMIT', 'LATE:1', 'SOMETHING_NEW'],
      orders: [
        { orderId: 'order-100', number: 'SO-2026-0100', customerCode: 'C-BETA', baskets: 6, inCharge: false, due: '2026-12-01', late: true },
        { orderId: 'order-103', number: 'SO-2026-0103', customerCode: 'C-GAMMA', baskets: 4, inCharge: true, due: null, late: false },
      ],
    },
    { team: LIA, load: { inWork: null, maxBaskets: null }, marks: ['NO_NEW_ORDERS'], orders: [{ orderId: 'order-105', number: 'SO-2026-0105', customerCode: 'C-BETA', baskets: null, inCharge: true, due: '2026-12-12', late: true }] },
  ],
  teams: [
    { ...NOOR, takesNewOrders: true },
    { ...KIAN, takesNewOrders: true },
    { ...LIA, takesNewOrders: false },
  ],
}

export const PEOPLE: ReadonlyMap<string, TeamPeople> = new Map([
  [
    NOOR.id,
    {
      lineId: 'line-a',
      members: [
        { employeeId: 'emp-noor', name: 'Noor Nadir', isLead: true, onLoan: false },
        { employeeId: 'emp-omar', name: 'Omar Ortis', isLead: false, onLoan: false },
        { employeeId: 'emp-petra', name: 'Petra Pane', isLead: false, onLoan: true },
      ],
    },
  ],
  [KIAN.id, { lineId: 'line-b', members: [{ employeeId: 'emp-kian', name: 'Kian Kole', isLead: true, onLoan: false }, { employeeId: 'emp-wes', name: 'Wes Weaver', isLead: false, onLoan: false }] }],
  [LIA.id, { lineId: null, members: [{ employeeId: 'emp-lia', name: 'Lia Lunde', isLead: false, onLoan: false }, { employeeId: 'emp-carla', name: 'Carla Corte', isLead: false, onLoan: false }] }],
])

const facts = (over: Partial<OrderTeams['rows'][number]['facts']> = {}): OrderTeams['rows'][number]['facts'] => ({ inWork: 9, maxBaskets: 12, workedForCustomer: false, takesNewOrders: true, overLimit: false, missingToday: null, late: null, ...over })

/** SO-2026-0100: Team Noor and Team Kian work together, Noor in charge; not printed. */
export const TOGETHER: OrderTeams = {
  orderId: 'order-100',
  version: 3,
  printed: false,
  mode: 'TOGETHER',
  plannedBaskets: 12,
  rows: [
    { team: NOOR, inCharge: true, basketShare: null, givenBy: 'USER', facts: facts({ workedForCustomer: true, missingToday: 2 }) },
    { team: KIAN, inCharge: false, basketShare: null, givenBy: 'USER', facts: facts({ inWork: 14, overLimit: true, late: 1 }) },
  ],
  may: { give: true, ask: false },
}

/** SO-2026-0104: split 7 / 5 and printed: the shares were made at print. */
export const SPLIT_PRINTED: OrderTeams = {
  orderId: 'order-104',
  version: 5,
  printed: true,
  mode: 'SPLIT',
  plannedBaskets: 12,
  rows: [
    { team: NOOR, inCharge: true, basketShare: 7, givenBy: 'USER', facts: facts() },
    { team: KIAN, inCharge: false, basketShare: 5, givenBy: 'USER', facts: facts({ inWork: 14, overLimit: true }) },
  ],
  may: { give: true, ask: false },
}

/** SO-2026-0107: no team yet. */
export const NO_TEAM: OrderTeams = { orderId: 'order-107', version: 1, printed: false, mode: 'NONE', plannedBaskets: 8, rows: [], may: { give: true, ask: false } }

/** SO-2026-0103: one team, given by its order structure; as sales reads it. */
export const BY_RULE_SALES: OrderTeams = {
  orderId: 'order-103',
  version: 2,
  printed: false,
  mode: 'ONE',
  plannedBaskets: 4,
  rows: [{ team: KIAN, inCharge: true, basketShare: null, givenBy: 'RULE', facts: facts({ inWork: 14, overLimit: true }) }],
  may: { give: false, ask: true },
}

const MANAGER = teamsRightsOf(['workorders.view', 'production.teams.assign', 'people.view', 'people.loans.manage', 'people.structure.manage'])
const SALES = teamsRightsOf(['workorders.view', 'orders.view'])

const page = (over: Partial<TeamsBoardViewModel> = {}): TeamsBoardViewModel => ({
  prefix: PREFIX,
  rights: MANAGER,
  state: 'ready',
  problem: null,
  board: boardModelOf(BOARD, PEOPLE),
  sites: [],
  filter: 'all',
  notice: null,
  newTeamHref: `${PREFIX}/people/structure?new=team`,
  ...over,
})

export const designScreen = defineDesignScreen<TeamsBoardViewModel>({
  screen: 'SCR-owb-teams',
  title: 'Production › Teams — a column a team, No team yet, Give to a team…, Lend (owb-ss7)',
  view: TeamsBoardView,
  cases: [
    { id: 'manager', label: 'The production manager: three teams, No team yet, an order two teams make together', model: page(), note: 'Team Lia has 2 people: "—" and the ⓘ "Small teams show no numbers"; Team Kian is over its limit; the unknown mark code is not drawn.' },
    { id: 'sales', label: 'Sales reads the page', model: page({ rights: SALES, board: boardModelOf(BOARD, null) }), note: 'No Give, no lend, no people chips (no people.view); "You read this page".' },
    { id: 'saved', label: 'After a save', model: page({ notice: { key: 'notice.saved' } }) },
    { id: 'site', label: '"All sites" with two sites: choose the site first', model: page({ state: 'site', board: null, sites: [{ id: 'site-a1', name: 'Site A1' }, { id: 'site-b2', name: 'Site B2' }] }) },
    { id: 'reading', label: 'Reading', model: page({ state: 'reading', board: null }) },
    { id: 'failed', label: 'The board could not be read', model: page({ state: 'failed', board: null, problem: 'error.offline' }) },
  ],
})
