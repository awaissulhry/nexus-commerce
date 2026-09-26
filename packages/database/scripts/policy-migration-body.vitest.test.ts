import { expect, it } from 'vitest'
import { policyMigrationBody } from './policy-migration-body.mjs'

const policy = 'CREATE POLICY expected ON table_name USING (true);\n'
it('accepts the exact shared tail inside a complete outer transaction', () => {
  expect(policyMigrationBody(`BEGIN;\nCREATE TABLE table_name (id int);\n${policy}COMMIT;\n`).endsWith(policy)).toBe(true)
  expect(policyMigrationBody(policy)).toBe(policy)
})
it.each([
  `BEGIN;\n${policy}`,
  `BEGIN;\n${policy}ROLLBACK;\n`, `${policy}COMMIT;\n`, `BEGIN;\n${policy}COMMIT;\nSELECT 1;\n`,
  `BEGIN;\n${policy}SELECT 1;\nCOMMIT;\n`, `BEGIN;\n${policy.replace('(true)', '(false)')}COMMIT;\n`,
  `BEGIN;\n${policy.trimEnd()}COMMIT;\n`,
])('refuses extra statements, incomplete wrappers and changed policy bytes', sql => {
  expect(policyMigrationBody(sql).endsWith(policy)).toBe(false)
})
