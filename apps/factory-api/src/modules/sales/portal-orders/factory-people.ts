import type { FastifyInstance, FastifyRequest } from 'fastify'
import { portalReader } from './access'

/**
 * Factory people for your brand (owb- order workflow, S1 po2.4; design § 5 "Your people … Factory people for your brand"; the base's
 * pool `PartyOfficePerson`, G11): GET /portal/factory-people — the office people the factory gave THIS customer (open pool rows of
 * the party: the partner read, row-level security), each with their name, their role in words and a picture of letters (no photo
 * yet: plan.md § 5 K). Never a worker or a team (the pool holds office users only), never a phone or an e-mail (the pool row has
 * no "shown" flag yet: so never), never an office note. The names and roles are read in the tenant's scope after the partner read
 * found the pool rows (the partner role reads no role assignment).
 */

type Words = { readonly en: string; readonly it: string }

/** The role words of the office roles a customer may meet (template keys); any other role: its own name in both. */
const ROLE_WORDS: Readonly<Record<string, Words>> = Object.freeze({
  owner: { en: 'Owner', it: 'Titolare' },
  admin: { en: 'Administrator', it: 'Amministratore' },
  sales: { en: 'Sales', it: 'Vendite' },
  designer: { en: 'Designer', it: 'Designer' },
  production_manager: { en: 'Production manager', it: 'Responsabile produzione' },
  planner: { en: 'Planner', it: 'Pianificazione' },
  finance: { en: 'Finance', it: 'Amministrazione' },
  quality: { en: 'Quality', it: 'Qualità' },
})

export interface FactoryPerson {
  readonly id: string
  readonly name: string
  readonly role: Words
  readonly picture: { readonly kind: 'LETTERS' | 'ICON'; readonly icon: string | null; readonly colour: string | null }
}

/** GET /portal/factory-people (see the file's head). */
export async function factoryPeople(app: FastifyInstance, request: FastifyRequest): Promise<{ people: FactoryPerson[] }> {
  const reader = portalReader(app, request)
  const partyId = reader.session.partyId
  const pool = await request.withClient((client) => client.partyOfficePerson.findMany({ where: { partyId, endedAt: null }, select: { userId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  const userIds = [...new Set(pool.map((row) => row.userId))]
  if (userIds.length === 0) return { people: [] }
  const tenant = await reader.inTenant(async (client) => {
    const users = await client.user.findMany({ where: { id: { in: userIds }, audience: 'OFFICE', status: 'ACTIVE' }, select: { id: true, displayName: true } })
    const now = new Date()
    const roles = await client.roleAssignment.findMany({ where: { userId: { in: users.map((user) => user.id) }, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] }, select: { userId: true, role: { select: { key: true, name: true, audience: true } } }, orderBy: [{ validFrom: 'asc' }, { id: 'asc' }] })
    return { users: new Map(users.map((user) => [user.id, user.displayName])), roles }
  })
  const people: FactoryPerson[] = []
  for (const userId of userIds) {
    const name = tenant.users.get(userId)
    if (!name) continue
    const role = tenant.roles.find((row) => row.userId === userId && row.role.audience === 'OFFICE')?.role
    people.push({ id: userId, name, role: role ? (ROLE_WORDS[role.key] ?? { en: role.name, it: role.name }) : { en: 'The factory', it: 'La fabbrica' }, picture: { kind: 'LETTERS', icon: null, colour: null } })
  }
  return { people }
}
