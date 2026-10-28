import { describe, expect, it } from 'vitest'
import { policyInputs } from './ownership'
import {
  checkPolicyParity,
  isPolicyMigration,
  platformPolicySql,
  POLICY_MIGRATION_HEADER,
  policyMigrationSql,
  readMigrations,
  runtimeLoginSql,
  type Migration,
} from './policies'
import { RUNTIME_LOGIN, RUNTIME_ROLES } from './roles'
import { generatedPolicySql, loadOwnership, loadSchema, MIGRATIONS_DIR } from './tools'

const migrations = readMigrations(MIGRATIONS_DIR)
const expected = generatedPolicySql()

describe('the policy migration', () => {
  it('is deterministic: the order of models and roles in the input does not matter', () => {
    const files = structuredClone(loadOwnership()) as { file: string; data: { models: Record<string, any> } }[]
    const models = files[0]!.data.models
    files[0]!.data.models = Object.fromEntries(Object.entries(models).reverse())
    const schema = [...loadSchema()].reverse()
    expect(policyMigrationSql(policyInputs(schema, files))).toBe(expected)
    expect(expected.startsWith(POLICY_MIGRATION_HEADER)).toBe(true)
  })

  it('makes the login enter every runtime role without inheriting it, and locks set_config to it', () => {
    const login = runtimeLoginSql(RUNTIME_LOGIN, RUNTIME_ROLES)
    for (const role of RUNTIME_ROLES) expect(login).toContain(`GRANT "${role}" TO "factory_app" WITH INHERIT FALSE, SET TRUE;`)
    expect(login).not.toMatch(/ADMIN OPTION|INHERIT TRUE|SUPERUSER(?! )|BYPASSRLS(?! )/)
    expect(expected).toContain('REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC, "factory_floor_runtime"')
    expect(expected).toContain('GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO "factory_app";')
  })

  it('gives the platform role every row of a platform table, and nothing on a tenant table', () => {
    expect(expected).toContain('CREATE POLICY "factory_platform_select" ON "public"."Tenant" AS PERMISSIVE FOR SELECT TO "factory_platform" USING (true);')
    expect(expected.match(/TO "factory_platform"/g)?.length).toBe(4) // 1 grant + 3 policies, all on Tenant
    // A platform table no runtime role shares gets its own row-level security, revoke and policy reset.
    const alone = platformPolicySql([{ table: 'Uom', privileges: ['select'], walled: false }], true)
    expect(alone).toContain('ALTER TABLE "public"."Uom" FORCE ROW LEVEL SECURITY;')
    expect(alone).toContain('REVOKE ALL ON TABLE "public"."Uom" FROM PUBLIC,')
    expect(alone).toContain('GRANT USAGE ON SCHEMA "public" TO "factory_platform";')
  })

  it('hides the floor role from the fiscal columns of Company with a column grant', () => {
    const grant = expected.split('\n').find((line) => line.startsWith('GRANT SELECT (') && line.includes('"Company" TO "factory_floor_runtime"'))
    expect(grant).toBeDefined()
    for (const column of ['vatNumber', 'fiscalCode', 'shareCapital', 'pec', 'sdiReceiverCode']) expect(grant).not.toContain(`"${column}"`)
    expect(grant).toContain('"legalName"')
  })
})

describe('policy parity', () => {
  it('holds for the checked-in migrations', () => {
    // The core's two first; each later module adds its own (their timestamps change when the lead merges them).
    expect(migrations.slice(0, 2).map((migration) => migration.folder)).toEqual(['202610281200__core_tenancy', '202610281201__core_policies'])
    expect(isPolicyMigration(migrations.at(-1) as Migration)).toBe(true)
    expect(checkPolicyParity(migrations, expected)).toEqual([])
  })

  const newest = migrations.at(-1) as Migration
  it.each<[string, Migration[], RegExp]>([
    ['a hand edit in the policy migration', [...migrations.slice(0, -1), { ...newest, sql: newest.sql.replace('USING (true)', 'USING (1 = 1)') }], /differs from the generator at line \d+/],
    ['a dropped policy line', [...migrations.slice(0, -1), { ...newest, sql: newest.sql.replace(/^CREATE POLICY "factory_runtime_update" ON "public"."Line".*\n/m, '') }], /differs from the generator/],
    ['a schema migration after the newest policy migration', [...migrations, { folder: '202610281300__core_more', sql: 'ALTER TABLE "Line" ADD COLUMN "note" TEXT;' }], /comes after the newest policy migration/],
    ['no policy migration at all', migrations.filter((migration) => !isPolicyMigration(migration)), /no policy migration/],
  ])('fails on %s', (_label, planted, problem) => {
    expect(checkPolicyParity(planted, expected)).toEqual(expect.arrayContaining([expect.stringMatching(problem)]))
  })

  it('fails when the classification changed but the migration was not regenerated', () => {
    const files = structuredClone(loadOwnership()) as { file: string; data: { models: Record<string, any> } }[]
    files[0]!.data.models.Line.access.factory_runtime.privileges = ['select', 'insert', 'update', 'delete']
    const changed = policyMigrationSql(policyInputs(loadSchema(), files))
    expect(checkPolicyParity(migrations, changed)).toEqual([expect.stringMatching(/differs from the generator/)])
  })
})
