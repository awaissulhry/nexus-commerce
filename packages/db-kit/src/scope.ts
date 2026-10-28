/**
 * The scope of a database transaction: which role it runs as and which settings (tenant, actor, site, party …) the
 * row-level-security policies read. Generic: the role and the setting names are parameters, nothing here names the
 * factory.
 *
 * Fail closed: a scope is checked when it is made. A required setting without a value, an unknown key or a malformed
 * name throws `TenantScopeError`; there is no "legacy" or "all tenants" fallback.
 */

export type TenantScopeErrorCode =
  /** A required setting has no value, or no scope was given. */
  | 'scope_required'
  /** The scope definition or a value is malformed (bad role or setting name, unknown key, wrong type). */
  | 'scope_invalid'
  /** A statement that could change or escape the scope (see sql-guard.ts). */
  | 'statement_refused'
  /** A statement on a transaction that already ended, or a method the scoped adapter does not offer. */
  | 'scope_closed'

export class TenantScopeError extends Error {
  constructor(
    readonly code: TenantScopeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TenantScopeError'
  }
}

export interface ScopeSetting {
  /** The PostgreSQL setting the policies read, e.g. `factory.tenant_id`. Lower case, with a dotted prefix. */
  readonly setting: string
  /** Required: every scope must carry a non-empty value. Optional: an absent value is set to '' (no row matches). */
  readonly required: boolean
}

export interface ScopeDefinition<K extends string = string> {
  /** The role every transaction enters (`SET LOCAL ROLE`), e.g. `factory_runtime`. */
  readonly role: string
  /** Keyed settings, e.g. `{ tenantId: { setting: 'factory.tenant_id', required: true } }`. May be empty. */
  readonly settings: Readonly<Record<K, ScopeSetting>>
}

/** A value per key; `null` or a missing key means "not set" and is allowed only for optional settings. */
export type ScopeValues<K extends string = string> = Readonly<Partial<Record<K, string | null>>>

/** A checked, frozen scope: the role and every setting with its value, in the definition's key order. */
export interface Scope {
  readonly role: string
  readonly settings: readonly (readonly [setting: string, value: string])[]
}

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/
const SETTING = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+$/

/** Throws unless the definition is well formed: a lower-case role, unique dotted setting names, no `role` setting. */
export function checkScopeDefinition(definition: ScopeDefinition): void {
  if (definition === null || typeof definition !== 'object') {
    throw new TenantScopeError('scope_invalid', 'A scope definition is required.')
  }
  if (typeof definition.role !== 'string' || !ROLE.test(definition.role)) {
    throw new TenantScopeError('scope_invalid', `Invalid scope role: ${JSON.stringify(definition.role)}.`)
  }
  const seen = new Set<string>()
  for (const [key, entry] of Object.entries<ScopeSetting>(definition.settings ?? {})) {
    if (entry === null || typeof entry !== 'object' || typeof entry.setting !== 'string' || !SETTING.test(entry.setting)) {
      throw new TenantScopeError('scope_invalid', `Invalid setting name for ${key}: it must be lower case with a dotted prefix.`)
    }
    if (typeof entry.required !== 'boolean') {
      throw new TenantScopeError('scope_invalid', `Setting ${key} must say whether it is required.`)
    }
    if (seen.has(entry.setting)) throw new TenantScopeError('scope_invalid', `Setting ${entry.setting} is listed twice.`)
    seen.add(entry.setting)
  }
}

/**
 * Checks the values against the definition and returns the frozen scope. Throws `scope_required` when a required value
 * is missing or empty, and `scope_invalid` for an unknown key or a value that is not a string.
 */
export function makeScope<K extends string>(definition: ScopeDefinition<K>, values: ScopeValues<K> | undefined): Scope {
  checkScopeDefinition(definition)
  if (values === undefined || values === null || typeof values !== 'object') {
    throw new TenantScopeError('scope_required', 'A database scope is required: no query runs without one.')
  }
  const settings = definition.settings as Readonly<Record<string, ScopeSetting>>
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(settings, key)) throw new TenantScopeError('scope_invalid', `Unknown scope key: ${key}.`)
  }
  const pairs = Object.entries(settings).map(([key, entry]) => {
    const value = (values as Record<string, unknown>)[key]
    if (value === undefined || value === null || value === '') {
      if (entry.required) throw new TenantScopeError('scope_required', `The database scope needs ${key}.`)
      return Object.freeze([entry.setting, ''] as const)
    }
    if (typeof value !== 'string') throw new TenantScopeError('scope_invalid', `Scope value ${key} must be a string.`)
    if (value.includes('\u0000')) throw new TenantScopeError('scope_invalid', `Scope value ${key} contains a NUL character.`)
    return Object.freeze([entry.setting, value] as const)
  })
  return Object.freeze({ role: definition.role, settings: Object.freeze(pairs) })
}

/**
 * The one statement that enters the scope: `SELECT set_config($1, $2, true), set_config($3, $4, true), …`. The role
 * comes first (`set_config('role', …)` is `SET LOCAL ROLE`, with the same membership check). Every name and value is a
 * bound parameter; the text depends only on how many settings there are. `true` keeps each setting local to the
 * transaction, so all of them end with it, also behind a pooler in transaction mode.
 */
export function scopeStatement(scope: Scope): { sql: string; values: string[] } {
  const pairs: (readonly [string, string])[] = [['role', scope.role], ...scope.settings]
  const sql = `SELECT ${pairs.map((_, index) => `set_config($${index * 2 + 1}, $${index * 2 + 2}, true)`).join(', ')}`
  return { sql, values: pairs.flatMap(([name, value]) => [name, value]) }
}
