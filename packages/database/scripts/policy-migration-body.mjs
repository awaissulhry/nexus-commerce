/** Only a complete, exact outer transaction wrapper may follow the shared tail.
 * No whitespace/comment/statement normalization inside the policy body. */
export function policyMigrationBody(sql) {
  if (sql.startsWith('BEGIN;\n') !== sql.endsWith('COMMIT;\n')) return ''
  if (sql.startsWith('BEGIN;\n') && sql.endsWith('COMMIT;\n')) {
    return sql.slice('BEGIN;\n'.length, -'COMMIT;\n'.length)
  }
  return sql
}
