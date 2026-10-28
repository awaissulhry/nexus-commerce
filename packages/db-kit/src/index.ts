// @nexus/db-kit: generic, fail-closed database tools for the factory packages. No factory names in here: roles and
// setting names are parameters. See CLAUDE.md for what each part does.
export { describeUrlHost, isLoopbackHost, isLoopbackUrl } from './url-guard'
export {
  checkScopeDefinition,
  makeScope,
  scopeStatement,
  TenantScopeError,
  type Scope,
  type ScopeDefinition,
  type ScopeSetting,
  type ScopeValues,
  type TenantScopeErrorCode,
} from './scope'
export { checkStatement, type StatementKind } from './sql-guard'
export { TenantPg } from './tenant-adapter'
export { AuditedPool, auditRuntimeRole, UnsafeRuntimeLoginError, type RuntimeRoleAudit } from './runtime-role'
export {
  lockSetConfigSql,
  policySql,
  PolicyModelError,
  runtimeRoleSql,
  tablePolicySql,
  type PolicyKey,
  type PolicyModel,
  type Privilege,
  type RoleAccess,
  type TablePolicy,
} from './policy-sql'
