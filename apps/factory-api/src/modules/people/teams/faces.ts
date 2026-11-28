import type { FactoryClient } from '@nexus/factory-db'
import { teamPicture, type Picture } from '@nexus/factory-domain/people/teams/picture'
import type { CommandTx } from '../../../core/command'
import { nameOf } from '../employees/store'
import { minimumGroupSizeFor } from '../privacy/groups'

/**
 * owb-ss5 (S3; _owb-ss-common L11) — a team's face as every S3 read sends it (order teams, the teams board, the factory structure,
 * the order structures): its id, name, picture (letters or one of 12 icons on a grid tone; never a photo), its leader (the member
 * with the lead) and how many people are in it today. The count is null for a team smaller than its company's people settings'
 * `minimumGroupSize` (3 by default, ANA-075): a figure about a team of one or two is a figure about a person.
 */

type Client = FactoryClient | CommandTx

export interface TeamFace {
  readonly id: string
  readonly name: string
  readonly picture: Picture
  readonly leader: { readonly employeeId: string; readonly name: string } | null
  readonly people: number | null
}

/** The faces of these teams, keyed by id (an id this session cannot read is left out). One read per table. */
export async function teamFaces(client: Client, teamIds: readonly string[]): Promise<Map<string, TeamFace & { readonly companyId: string; readonly siteId: string; readonly members: number; readonly minimumGroupSize: number }>> {
  const ids = [...new Set(teamIds)]
  if (ids.length === 0) return new Map()
  const teams = await client.team.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, siteId: true, name: true, pictureKind: true, pictureIcon: true, pictureColour: true } })
  const members = await client.teamMember.findMany({
    where: { teamId: { in: teams.map((team) => team.id) }, until: null },
    select: { teamId: true, employeeId: true, isLead: true, employee: { select: { firstName: true, lastName: true } } },
  })
  const minimum = new Map<string, number>()
  for (const companyId of new Set(teams.map((team) => team.companyId))) minimum.set(companyId, await minimumGroupSizeFor(client, companyId))
  return new Map(
    teams.map((team) => {
      const own = members.filter((member) => member.teamId === team.id)
      const lead = own.find((member) => member.isLead)
      const smallest = minimum.get(team.companyId) ?? 3
      return [
        team.id,
        {
          id: team.id,
          companyId: team.companyId,
          siteId: team.siteId,
          name: team.name,
          picture: teamPicture({ name: team.name, pictureKind: team.pictureKind, pictureIcon: team.pictureIcon, pictureColour: team.pictureColour }),
          leader: lead ? { employeeId: lead.employeeId, name: nameOf(lead.employee) } : null,
          people: own.length >= smallest ? own.length : null,
          members: own.length,
          minimumGroupSize: smallest,
        },
      ] as const
    }),
  )
}

/** The face only (what a Shape's `TeamFace` carries), without the facts the server keeps for itself. */
export const faceOnly = (face: TeamFace): TeamFace => ({ id: face.id, name: face.name, picture: face.picture, leader: face.leader, people: face.people })
