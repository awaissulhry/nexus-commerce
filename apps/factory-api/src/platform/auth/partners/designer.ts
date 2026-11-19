import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { designerState, designerWords, DESIGNER_WORDS, personRefusals, portalDesignerName, slotRefusals, type DesignerCandidate, type DesignerRefusal } from '@nexus/factory-domain/auth/partners/designer'
import { PARTNERS_VIEW } from '@nexus/factory-domain/auth/partners/permissions'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { StaleVersionError, type CommandTx } from '../../../core/command'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { portalSessionOf } from '../portal/authenticator'
import { portalOf } from '../portal/service'
import { heldRoles } from '../roles/access'
import type { OfficeAuth } from '../sessions/office-auth'
import { mayChange } from './office'
import { lockParty, partyById, type PartnerParty } from './store'

/**
 * B-CP-078 (customer page plan C7, D12; 12 §5; review C4, F7; lead pick: NO step-up — a name, no money, no access; walls W-CP-5):
 * the factory designer of a customer, and its backup — PortalSettings.factoryDesignerId (+ since when) and factoryDesignerBackupId,
 * office only (the partner role has no grant on the table). The customer's portal people may ask this ONE person in a thread
 * (B-CP-079); they read the display name and nothing else of ours.
 *
 *   GET /partners/:partyId/factory-designer           the slot as the office reads it ("Who looks after Brand Alpha"): each person's
 *                                                     name and state — still reaching the customer, or "No longer reaches Brand
 *                                                     Alpha" / "No longer active" (a person stays named until changed) —, since
 *                                                     when, the stored version (0: no settings row), whether the portal is on and
 *                                                     whether the reader may change it (partners.view over the customer)
 *   GET /partners/:partyId/factory-designer/choices   who may be named: ACTIVE office people holding threads.read AND threads.post
 *                                                     over the customer at every company it works with (names only, at most 500
 *                                                     read) — partners.manage over every company of the customer
 *   PUT /partners/:partyId/factory-designer           {designerId|null, backupId|null, version}: partners.manage over every company
 *                                                     of the customer (a customer of every company: a grant over every company),
 *                                                     no step-up; a person newly named is checked (refusals at the field: NOT_OFFICE
 *                                                     · NOT_ACTIVE · NO_REACH; the slot: BACKUP_ALONE · SAME_PERSON); the settings
 *                                                     row is made with the portal OFF when the customer has none; one audit row
 *   GET /portal/factory-designer                      {name}: the designer's display name while active, else the backup's, else
 *                                                     null — never an id, an e-mail, a role or whether two names exist; a party
 *                                                     whose portal is off: 404 (review C4)
 *
 * A customer out of the caller's reach is "Customer not found." — word for word an unknown id's (the brand-wall sweep). The slot
 * does not ask for the office role "Factory designer" (review F7: an offer, not a condition).
 */

type Reader = FactoryClient | CommandTx

const CUSTOMER_NOT_FOUND = 'Customer not found.'
/** The most office people one pick list reads. */
export const DESIGNER_PICK_MAX = 500

/** One place the designer must reach: a company of the customer, and the customer. */
interface Scope {
  readonly companyId: string
  readonly partyId: string
}

/** The companies the customer works with: its own company, else every ACTIVE company of the tenant. */
async function scopesOf(db: Reader, party: PartnerParty): Promise<Scope[]> {
  const companies = party.companyId !== null ? [party.companyId] : (await db.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id)
  return companies.map((companyId) => ({ companyId, partyId: party.id }))
}

/** A factory designer is a customer's or a brand's (the database's rule too). */
const isCustomer = (party: PartnerParty): boolean => party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')

/** The person as the rule reads them (null: no such person in the tenant): their account, and whether their live grants reach. */
async function candidateOf(db: Reader, tenantId: string, userId: string, scopes: readonly Scope[], now: Date): Promise<(DesignerCandidate & { readonly id: string; readonly name: string }) | null> {
  if (!isUuid(userId)) return null
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, audience: true, status: true } })
  if (!user) return null
  // Their LIVE office roles (two-factor taken as proved: they prove it to sign in), as sales' and production's pick lists read them.
  const actor: Actor = { audience: 'office', tenantId, grants: user.audience === 'OFFICE' ? sessionGrants({ requireMfa: false }, await heldRoles(db, user.id, now), true) : [] }
  const reaches = scopes.length > 0 && scopes.every((scope) => can(actor, THREADS_READ, scope) && can(actor, THREADS_POST, scope))
  return { id: user.id, name: user.displayName, audience: user.audience, status: user.status, reaches }
}

/** The customer as the caller reaches it (partners.view, else "Customer not found."), and whether they may change its slot. */
async function reachCustomer(request: FastifyRequest, partyId: string): Promise<{ context: OfficeContext; actor: Actor; party: PartnerParty; mayManage: boolean }> {
  const context = requireContext(request) as OfficeContext
  const actor = actorOf(context)
  const party = isUuid(partyId) ? await request.withClient((client) => partyById(client, partyId)) : null
  if (!party || !can(actor, PARTNERS_VIEW, { companyId: party.companyId, partyId: party.id })) throw new NotFoundError(CUSTOMER_NOT_FOUND)
  return { context, actor, party, mayManage: mayChange(actor, party, 'partners.manage') }
}

const MANAGE_HELD = "Your role does not name this customer's factory designer at every company it works with."

const refusalIssues = (refusals: readonly DesignerRefusal[], path: string, customer: string): Issue[] => refusals.map((refusal) => ({ path, message: designerWords(refusal, customer).en }))

/** The slot as the office reads it. */
async function slotAnswer(db: Reader, tenantId: string, party: PartnerParty, mayManage: boolean, now: Date) {
  const row = await db.portalSettings.findUnique({ where: { id: party.id }, select: { portalOn: true, factoryDesignerId: true, factoryDesignerSetAt: true, factoryDesignerBackupId: true, version: true } })
  const scopes = await scopesOf(db, party)
  const person = async (userId: string | null | undefined) => {
    if (!userId) return null
    const candidate = await candidateOf(db, tenantId, userId, scopes, now)
    const state = designerState(candidate)
    return { id: userId, name: candidate?.name ?? '', state, words: state === 'OK' ? null : designerWords(state === 'NO_REACH' ? 'NO_LONGER_REACHES' : 'NO_LONGER_ACTIVE', party.name) }
  }
  return {
    factoryDesigner: {
      partyId: party.id,
      designer: await person(row?.factoryDesignerId),
      backup: await person(row?.factoryDesignerBackupId),
      since: row?.factoryDesignerSetAt ? toUtcIso(row.factoryDesignerSetAt) : null,
      portalOn: row?.portalOn ?? false,
      version: row?.version ?? 0,
      mayManage,
    },
  }
}

/** GET /partners/:partyId/factory-designer */
export async function factoryDesigner(auth: OfficeAuth, request: FastifyRequest, partyId: string) {
  const { context, party, mayManage } = await reachCustomer(request, partyId)
  return request.withClient((db) => slotAnswer(db, context.tenantId, party, mayManage, auth.clock.now()))
}

/** GET /partners/:partyId/factory-designer/choices */
export async function factoryDesignerChoices(auth: OfficeAuth, request: FastifyRequest, partyId: string) {
  const { context, party, mayManage } = await reachCustomer(request, partyId)
  if (!mayManage) throw new ForbiddenError(MANAGE_HELD)
  const now = auth.clock.now()
  return request.withClient(async (db) => {
    const scopes = await scopesOf(db, party)
    const users = await db.user.findMany({ where: { status: 'ACTIVE', audience: 'OFFICE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: DESIGNER_PICK_MAX, select: { id: true } })
    const people: { id: string; name: string; me: boolean }[] = []
    for (const user of users) {
      const candidate = await candidateOf(db, context.tenantId, user.id, scopes, now)
      if (candidate && personRefusals(candidate).length === 0) people.push({ id: candidate.id, name: candidate.name, me: candidate.id === context.actorId })
    }
    return { people, complete: users.length < DESIGNER_PICK_MAX }
  })
}

export interface FactoryDesignerBody {
  readonly designerId: string | null
  readonly backupId: string | null
  /** The stored version read (0: no settings row yet). */
  readonly version: number
}

/** PUT /partners/:partyId/factory-designer (see the file's head). */
export async function setFactoryDesigner(auth: OfficeAuth, request: FastifyRequest, partyId: string, body: FactoryDesignerBody, idempotencyKey?: string) {
  const { context, party, mayManage } = await reachCustomer(request, partyId)
  if (!mayManage) throw new ForbiddenError(MANAGE_HELD)
  if (!isCustomer(party)) {
    const message = DESIGNER_WORDS.ONLY_CUSTOMERS.en
    throw new DomainError('conflict', message, [{ path: 'params/partyId', message }])
  }
  const shape = refusalIssues(slotRefusals(body), 'body/backupId', party.name)
  if (shape.length > 0) throw new ValidationError(shape[0]!.message, shape)
  const { result } = await auth.command(context, { name: 'partners.setFactoryDesigner', idempotencyKey, input: { partyId, ...body } }, async ({ tx, audit, now }) => {
    await lockParty(tx, party.id)
    const before = await tx.portalSettings.findUnique({ where: { id: party.id }, select: { factoryDesignerId: true, factoryDesignerBackupId: true, version: true } })
    const version = before?.version ?? 0
    if (body.version !== version) throw new StaleVersionError('PortalSettings', party.id, version, body.version)
    const designerMoved = body.designerId !== (before?.factoryDesignerId ?? null)
    const backupMoved = body.backupId !== (before?.factoryDesignerBackupId ?? null)
    if (!designerMoved && !backupMoved) throw new InvalidStateError(DESIGNER_WORDS.NOTHING_CHANGES.en)
    // A person newly named in a slot is checked (one named already stays, even if made inactive or out of reach since).
    const scopes = await scopesOf(tx, party)
    const issues: Issue[] = []
    if (designerMoved && body.designerId !== null) issues.push(...refusalIssues(personRefusals(await candidateOf(tx, context.tenantId, body.designerId, scopes, now)), 'body/designerId', party.name))
    if (backupMoved && body.backupId !== null) issues.push(...refusalIssues(personRefusals(await candidateOf(tx, context.tenantId, body.backupId, scopes, now)), 'body/backupId', party.name))
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
    const data = { factoryDesignerId: body.designerId, factoryDesignerSetAt: designerMoved ? (body.designerId === null ? null : now) : undefined, factoryDesignerBackupId: body.backupId }
    if (before) {
      await tx.portalSettings.update({ where: { id: party.id }, data: { ...data, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    } else {
      // One row per party, its id the party's (B-W2b-152); the portal stays OFF (naming a designer opens no portal).
      await tx.portalSettings.create({ data: { id: party.id, partyId: party.id, portalOn: false, ...data, factoryDesignerSetAt: body.designerId === null ? null : now, createdAt: now, createdById: context.actorId }, select: { id: true } })
    }
    audit({
      recordType: 'PortalSettings',
      recordId: party.id,
      companyId: party.companyId,
      before: before ? { factoryDesignerId: before.factoryDesignerId, factoryDesignerBackupId: before.factoryDesignerBackupId } : null,
      after: { factoryDesignerId: body.designerId, factoryDesignerBackupId: body.backupId, ...(before ? {} : { portalOn: false, made: 'portal settings made with the portal off' }) },
    })
    return slotAnswer(tx, context.tenantId, party, mayManage, now)
  })
  return result
}

/** GET /portal/factory-designer — the one name the customer's people may ask (see the file's head). */
export async function portalFactoryDesigner(app: FastifyInstance, request: FastifyRequest): Promise<{ name: string | null }> {
  const session = portalSessionOf(request)
  // The partner role has no grant on PortalSettings: read in the tenant's scope as the person, its own party only.
  return portalOf(app).auth.inTenant(session.tenantId, session.userId, async (db) => {
    const row = await db.portalSettings.findUnique({ where: { id: session.partyId }, select: { portalOn: true, factoryDesignerId: true, factoryDesignerBackupId: true } })
    if (!row || !row.portalOn) throw new NotFoundError('Not found.')
    const person = async (userId: string | null) => {
      if (userId === null) return null
      const user = await db.user.findUnique({ where: { id: userId }, select: { displayName: true, audience: true, status: true } })
      return user ? { name: user.displayName, active: user.audience === 'OFFICE' && user.status === 'ACTIVE' } : null
    }
    return { name: portalDesignerName({ designer: await person(row.factoryDesignerId), backup: await person(row.factoryDesignerBackupId) }) }
  })
}
