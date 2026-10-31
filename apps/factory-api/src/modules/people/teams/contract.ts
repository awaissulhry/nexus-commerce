import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { AREA_LIMITS, LOAN_LIMITS, LOAN_STATES, MOVE_CONFLICTS, TEAM_LIMITS } from '@nexus/factory-domain/people/teams/rules'
import { refOut } from '../employees/contract'

/**
 * Lines, teams and leads, loans to another line, and the site › area › line › station tree (B-W2b-26; MES-210, PLT-020,
 * PLT-005; design people.employees "Teams view", "Loan to another line", "Change team"; admin.org "Lines and stations").
 * A team holds names, never a figure about one person's work (Statuto dei Lavoratori art. 4).
 */

const version = () => z.number().int().min(1)
const code = (max: number) => z.string().trim().min(1).max(max)
const name = (max: number) => z.string().trim().min(1).max(max)

const memberOut = output({
  employeeId: id(),
  name: z.string(),
  displayName: z.string(),
  isLead: z.boolean(),
  since: z.string(),
  /** Lent to another line today (until when), or null. */
  onLoan: output({ loanId: id(), toLine: refOut, until: z.string() }).nullable(),
})

const loanInOut = output({ loanId: id(), employeeId: id(), name: z.string(), fromLine: refOut.nullable(), startsAt: z.string(), until: z.string() })

export const teamOut = output({
  id: id(),
  companyId: id(),
  site: refOut,
  line: refOut.nullable(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  lead: output({ employeeId: id(), name: z.string() }).nullable(),
  members: z.array(memberOut),
  /** People lent to this team (or its line, with no team named) today. */
  loansIn: z.array(loanInOut),
  version: z.number().int(),
})

export const listTeamsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    companyId: id().optional(),
    lineId: id().optional(),
    includeArchived: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  }),
  response: { 200: output({ teams: z.array(teamOut), today: z.string() }) },
})

export const myTeamsContract = defineContract({
  response: {
    200: output({
      /** The caller's employee record (null: no record is linked to the account, so no team). */
      employeeId: id().nullable(),
      teams: z.array(teamOut.extend({ mine: z.enum(['LEAD', 'MEMBER']) })),
      today: z.string(),
    }),
  },
})

export const teamRecordContract = defineContract({
  params: input({ teamId: id() }),
  response: {
    200: output({
      team: teamOut,
      history: z.array(output({ employeeId: id(), name: z.string(), isLead: z.boolean(), since: z.string(), until: z.string() })),
      canManage: z.boolean(),
      today: z.string(),
    }),
  },
})

export const createTeamContract = defineContract({
  body: input({ siteId: id(), lineId: id().nullable().optional(), code: code(TEAM_LIMITS.code), name: name(TEAM_LIMITS.name) }),
  response: { 200: output({ team: teamOut }), 201: output({ team: teamOut }) },
})

export const updateTeamContract = defineContract({
  params: input({ teamId: id() }),
  body: input({ version: version(), name: name(TEAM_LIMITS.name).optional(), lineId: id().nullable().optional() }),
  response: { 200: output({ team: teamOut }) },
})

export const archiveTeamContract = defineContract({
  params: input({ teamId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ team: teamOut }) },
})

export const setLeadContract = defineContract({
  params: input({ teamId: id() }),
  body: input({ version: version(), employeeId: id().nullable() }),
  response: { 200: output({ team: teamOut }) },
})

const moves = z
  .array(output({ employeeId: id(), teamId: id().nullable() }).strict())
  .min(1)
  .max(TEAM_LIMITS.moves)

const moveRowOut = output({
  employeeId: id(),
  name: z.string().nullable(),
  from: output({ team: refOut, lead: z.string().nullable() }).nullable(),
  to: output({ team: refOut, lead: z.string().nullable() }).nullable(),
  change: z.enum(['NONE', 'MOVE']),
  conflict: z.enum(MOVE_CONFLICTS).nullable(),
  /** Not blocking: the person is the lead of the team they leave (it will have no lead). */
  leavesLead: z.boolean(),
})

export const previewMovesContract = defineContract({
  body: input({ moves }),
  response: { 200: output({ rows: z.array(moveRowOut), moving: z.number().int(), conflicts: z.number().int() }) },
})

export const applyMovesContract = defineContract({
  body: input({ moves, reason: z.string().trim().min(1).max(TEAM_LIMITS.reason).optional() }),
  response: { 200: output({ rows: z.array(moveRowOut), moved: z.number().int(), teams: z.array(id()) }) },
})

// ---- loans ---------------------------------------------------------------------------------------------------------------

export const loanOut = output({
  id: id(),
  site: refOut,
  employeeId: id(),
  name: z.string(),
  fromLine: refOut.nullable(),
  toLine: refOut,
  toTeam: refOut.nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  state: z.enum(LOAN_STATES),
  reason: z.string(),
  decidedBy: z.string().nullable(),
  version: z.number().int(),
})

export const listLoansContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    /** The day the loans overlap (default today). */
    date: businessDate().optional(),
    lineId: id().optional(),
    employeeId: id().optional(),
  }),
  response: { 200: output({ loans: z.array(loanOut), date: z.string() }) },
})

export const createLoanContract = defineContract({
  body: input({ employeeId: id(), toLineId: id(), toTeamId: id().nullable().optional(), startsAt: instant(), endsAt: instant(), reason: z.string().trim().min(1).max(LOAN_LIMITS.reason) }),
  response: { 200: output({ loan: loanOut }), 201: output({ loan: loanOut }) },
})

export const endLoanContract = defineContract({
  params: input({ loanId: id() }),
  body: input({ version: version(), endsAt: instant().optional() }),
  response: { 200: output({ loan: loanOut }) },
})

export const removeLoanContract = defineContract({
  params: input({ loanId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ removed: id() }) },
})

// ---- the org tree --------------------------------------------------------------------------------------------------------

const stationOut = output({ id: id(), code: z.string(), name: z.string(), status: z.string() })
const treeTeamOut = output({ id: id(), code: z.string(), name: z.string(), members: z.number().int() })
const treeLineOut = output({ id: id(), code: z.string(), name: z.string(), areaId: id().nullable(), status: z.string(), version: z.number().int(), stations: z.array(stationOut), teams: z.array(treeTeamOut) })
export const areaOut = output({ id: id(), siteId: id(), code: z.string(), name: z.string(), sortOrder: z.number().int(), status: z.enum(['ACTIVE', 'ARCHIVED']), version: z.number().int() })

export const orgTreeContract = defineContract({
  querystring: input({ siteId: id().optional(), companyId: id().optional(), includeArchived: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }),
  response: {
    200: output({
      sites: z.array(
        output({
          id: id(),
          companyId: id(),
          code: z.string(),
          name: z.string(),
          status: z.string(),
          areas: z.array(areaOut.extend({ lines: z.array(treeLineOut) })),
          linesWithoutArea: z.array(treeLineOut),
          stationsWithoutLine: z.array(stationOut),
          teamsWithoutLine: z.array(treeTeamOut),
          canManage: z.boolean(),
        }),
      ),
    }),
  },
})

export const createAreaContract = defineContract({
  params: input({ siteId: id() }),
  body: input({ code: code(AREA_LIMITS.code), name: name(AREA_LIMITS.name), sortOrder: z.number().int().optional() }),
  response: { 200: output({ area: areaOut }), 201: output({ area: areaOut }) },
})

export const updateAreaContract = defineContract({
  params: input({ areaId: id() }),
  body: input({ version: version(), name: name(AREA_LIMITS.name).optional(), sortOrder: z.number().int().optional() }),
  response: { 200: output({ area: areaOut }) },
})

export const archiveAreaContract = defineContract({
  params: input({ areaId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ area: areaOut }) },
})

export const setLineAreaContract = defineContract({
  params: input({ lineId: id() }),
  body: input({ version: version(), areaId: id().nullable() }),
  response: { 200: output({ line: output({ id: id(), siteId: id(), code: z.string(), name: z.string(), areaId: id().nullable(), version: z.number().int() }) }) },
})
