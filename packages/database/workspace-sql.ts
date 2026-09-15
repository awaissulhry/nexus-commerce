import { WorkspaceError } from './workspace-context.js'

/** Guard application raw SQL before Prisma adds its own transaction statements. */
export function assertWorkspaceSql(method: string, args: unknown[]): void {
  if (!/^\$(?:queryRaw|executeRaw)/.test(method)) return
  const input = args[0] as { sql?: string; strings?: string[] } | string | string[] | undefined
  const source = typeof input === 'string' ? input : Array.isArray(input) ? input.join(' ? ') : input?.sql ?? input?.strings?.join(' ? ') ?? ''
  // Values are bound separately. Strip ordinary literals and comments so words
  // such as "reset" in domain content cannot change the statement's classification.
  const sql = source.replace(/'(?:''|[^'])*'/g, "''").replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim()
  // This exact statement only removes write capability from the current transaction.
  // No role, workspace, session setting or READ WRITE counterpart is allowed.
  if (/^SET TRANSACTION READ ONLY$/i.test(sql)) return
  const forbidden = /\bset_config\b|U&"/i
  if (!/^(?:SELECT|INSERT|UPDATE|DELETE|WITH|EXPLAIN)\b/i.test(sql) || forbidden.test(sql) || /;\s*\S/.test(sql)) {
    throw new WorkspaceError('workspace_scope_immutable', 'Application SQL must stay inside its business transaction.')
  }
}
