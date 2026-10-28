/**
 * Permissions (plan A1 §3.11, features PLT-029 and PLT-037). Pure: the API builds the actor from the session, and the
 * same two functions answer every question.
 *
 *   can(actor, permission, record)        one record: the actor holds the permission in a grant whose scope covers
 *                                         the record, and the record's state allows the action
 *   scopeWhere(actor, permission, model)  a list: the filter (Prisma `where` shape) that keeps only the rows can()
 *                                         would allow, and matches no row when nothing is allowed
 *
 * Row-level security stops one tenant from reading another; these functions stop one company, site or customer from
 * leaking to staff limited to others inside a tenant (A1 §2.2). Everything fails closed: no grant, no permission, an
 * empty scope list, a partner record without a party, or an unknown audience all mean no.
 */

/** Who a session belongs to. `system` is the worker and scheduler acting for a tenant; HTTP routes never take it. */
export const AUDIENCES = ['office', 'floor', 'partner', 'link', 'platform', 'system'] as const
export type Audience = (typeof AUDIENCES)[number]

/** `<module>.<action>`, e.g. `quotes.send`, `workorders.release` (A1 §3.11). */
export type Permission = `${string}.${string}`

const PERMISSION = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION.test(value)
}

export function isAudience(value: unknown): value is Audience {
  return typeof value === 'string' && (AUDIENCES as readonly string[]).includes(value)
}

/**
 * Ids a grant reaches: every one (`'all'`) or exactly these. An empty list reaches none. A record without a company
 * (tenant-wide master data) is not limited by the company scope; the same holds for site and party.
 */
export type ScopeSet = 'all' | readonly string[]

/** One role assignment: its permissions and the companies, sites and parties they apply to (A1 §2.3 RoleAssignment). */
export interface Grant {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
  readonly sites: ScopeSet
  readonly parties: ScopeSet
}

/**
 * The caller. A floor session is bound to its device's site, a partner or link session to its party: those are fixed
 * by the session, whatever the grants say.
 */
export interface Actor {
  readonly audience: Audience
  /** Absent only for the platform audience. */
  readonly tenantId?: string
  readonly siteId?: string
  readonly partyId?: string
  readonly grants: readonly Grant[]
}

/** The scope columns of one record. A null company means tenant-wide master data ("all companies of the tenant"). */
export interface ScopedRecord {
  readonly tenantId?: string | null
  readonly companyId?: string | null
  readonly siteId?: string | null
  readonly partyId?: string | null
}

export type Denial = 'audience' | 'no_permission' | 'tenant' | 'company' | 'site' | 'party' | 'state'
export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly reason: Denial }

export interface CanOptions {
  /** The record's state machine allows this action now (A1 §2.5). Default true; false denies with reason `state`. */
  readonly stateAllows?: boolean
}

const ALLOW: Decision = Object.freeze({ allowed: true })
const deny = (reason: Denial): Decision => Object.freeze({ allowed: false, reason })

const reaches = (set: ScopeSet, id: string): boolean => set === 'all' || set.includes(id)
const PARTY_AUDIENCES: readonly Audience[] = ['partner', 'link']

function audienceIsValid(actor: Actor): boolean {
  if (!isAudience(actor.audience)) return false
  if (actor.audience === 'platform') return true
  if (!actor.tenantId) return false
  if (actor.audience === 'floor' && !actor.siteId) return false
  if (PARTY_AUDIENCES.includes(actor.audience) && !actor.partyId) return false
  return true
}

/** The actor's grants that hold this permission. */
export function grantsFor(actor: Actor, permission: Permission): Grant[] {
  if (!isPermission(permission)) return []
  return actor.grants.filter((grant) => grant.permissions.includes(permission))
}

/** The actor holds the permission in at least one grant (for any record). The route pipeline checks this first. */
export function holds(actor: Actor, permission: Permission): boolean {
  return audienceIsValid(actor) && grantsFor(actor, permission).length > 0
}

/** can() with the reason for a no. */
export function decide(actor: Actor, permission: Permission, record: ScopedRecord = {}, options: CanOptions = {}): Decision {
  if (!audienceIsValid(actor)) return deny('audience')
  const grants = grantsFor(actor, permission)
  if (grants.length === 0) return deny('no_permission')

  const { tenantId, siteId, partyId } = record
  if (actor.audience === 'platform') {
    if (tenantId) return deny('tenant')
  } else if (tenantId && tenantId !== actor.tenantId) {
    return deny('tenant')
  }
  if (actor.audience === 'floor' && siteId && siteId !== actor.siteId) return deny('site')
  if (PARTY_AUDIENCES.includes(actor.audience) && partyId !== actor.partyId) return deny('party')

  let reason: Denial | null = null
  for (const grant of grants) {
    reason = uncovered(grant, record)
    if (reason === null) break
  }
  if (reason !== null) return deny(reason)
  if (options.stateAllows === false) return deny('state')
  return ALLOW
}

/** The first scope of the record this grant does not reach, or null when it reaches the record. */
function uncovered(grant: Grant, { companyId, siteId, partyId }: ScopedRecord): Denial | null {
  if (companyId && !reaches(grant.companies, companyId)) return 'company'
  if (siteId && !reaches(grant.sites, siteId)) return 'site'
  if (partyId && !reaches(grant.parties, partyId)) return 'party'
  return null
}

/** True when the actor may do `permission` on this record (A1 §3.11 "Check"). */
export function can(actor: Actor, permission: Permission, record: ScopedRecord = {}, options: CanOptions = {}): boolean {
  return decide(actor, permission, record, options).allowed
}

/** A scope column of a model, by its field name; `nullable` when a null value means "every company / site". */
export type ScopeColumn = string | { readonly field: string; readonly nullable: true }

/** Which scope columns a model has. A model without a column is not scoped by it. */
export interface ScopeColumns {
  readonly company?: ScopeColumn
  readonly site?: ScopeColumn
  readonly party?: ScopeColumn
}

/** A Prisma-style `where` object, built from plain values (no Prisma import: this package does no I/O). */
export type WhereClause = { readonly [field: string]: unknown }

/** Matches no row. Every model has an `id` (A1 §2.1). */
export const NO_ROWS: WhereClause = Object.freeze({ id: Object.freeze({ in: Object.freeze([]) }) })

const columnOf = (column: ScopeColumn): { field: string; nullable: boolean } =>
  typeof column === 'string' ? { field: column, nullable: false } : { field: column.field, nullable: true }

/** `field = value`, or also `field IS NULL` when the column is nullable. */
function equals(column: ScopeColumn, value: string): WhereClause {
  const { field, nullable } = columnOf(column)
  return nullable ? { OR: [{ [field]: value }, { [field]: null }] } : { [field]: value }
}

/** `field IN ids` (or null); null when the set reaches every id; NO_ROWS when it reaches none. */
function within(column: ScopeColumn | undefined, set: ScopeSet): WhereClause | null {
  if (column === undefined || set === 'all') return null
  const { field, nullable } = columnOf(column)
  if (set.length === 0) return nullable ? { [field]: null } : NO_ROWS
  const ids = [...new Set(set)].sort()
  return nullable ? { OR: [{ [field]: { in: ids } }, { [field]: null }] } : { [field]: { in: ids } }
}

/**
 * The list filter for `permission` on a model with these scope columns (A1 §3.2 step 6): the rows can() allows,
 * written as a Prisma `where`. `{}` when every row of the tenant is allowed; NO_ROWS when none is. Combine it with
 * the caller's own filter as `{ AND: [scopeWhere(…), filter] }`, never by spreading.
 */
export function scopeWhere(actor: Actor, permission: Permission, columns: ScopeColumns): WhereClause {
  if (!audienceIsValid(actor)) return NO_ROWS
  const grants = grantsFor(actor, permission)
  if (grants.length === 0) return NO_ROWS

  const fixed: WhereClause[] = []
  if (actor.audience === 'floor' && columns.site !== undefined) fixed.push(equals(columns.site, actor.siteId!))
  if (PARTY_AUDIENCES.includes(actor.audience)) {
    // A partner sees only rows that name its party; a model without a party column is not partner data.
    if (columns.party === undefined) return NO_ROWS
    fixed.push({ [columnOf(columns.party).field]: actor.partyId! })
  }

  // Each grant reaches the rows inside all of its scopes; the actor reaches the rows any grant reaches.
  const reached: WhereClause[] = []
  for (const grant of grants) {
    const clauses = [
      within(columns.company, grant.companies),
      within(columns.site, grant.sites),
      within(columns.party, grant.parties),
    ].filter((clause): clause is WhereClause => clause !== null)
    if (clauses.includes(NO_ROWS)) continue
    if (clauses.length === 0) return combine(fixed)
    reached.push(and(clauses))
  }
  if (reached.length === 0) return NO_ROWS
  return combine([...fixed, reached.length === 1 ? reached[0]! : { OR: reached }])
}

const combine = (clauses: readonly WhereClause[]): WhereClause =>
  clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0]! : { AND: [...clauses] }

const and = (clauses: readonly WhereClause[]): WhereClause => (clauses.length === 1 ? clauses[0]! : { AND: [...clauses] })
