import { describe, expect, it } from 'vitest'
import { lockSetConfigSql, policySql, PolicyModelError, runtimeRoleSql, tablePolicySql, type PolicyModel, type TablePolicy } from './policy-sql'

const stockMove: TablePolicy = {
  table: 'StockMove',
  columns: ['id', 'tenantId', 'siteId', 'qty', 'unitCost'],
  keyColumns: { tenant: 'tenantId', site: 'siteId' },
  access: {
    office_rt: { privileges: ['select', 'insert'] },
    floor_rt: { privileges: ['insert', 'select'], scopedBy: ['site'], hiddenColumns: ['unitCost'] },
  },
}
const quote: TablePolicy = {
  table: 'Quote',
  columns: ['id', 'tenantId', 'partyId', 'total', 'margin', 'note'],
  keyColumns: { tenant: 'tenantId', party: 'partyId' },
  access: {
    office_rt: { privileges: ['select', 'insert', 'update', 'delete'] },
    partner_rt: { privileges: ['select'], scopedBy: ['party'], hiddenColumns: ['margin', 'note'] },
  },
}
const model: PolicyModel = {
  roles: ['office_rt', 'floor_rt', 'partner_rt'],
  keys: {
    tenant: { setting: 'example.tenant_id', type: 'uuid' },
    site: { setting: 'example.site_id', type: 'uuid' },
    party: { setting: 'example.party_id', type: 'uuid' },
  },
  alwaysScopedBy: ['tenant'],
  tables: [stockMove, quote],
}

describe('policySql', () => {
  it('writes the expected SQL for one table', () => {
    expect(tablePolicySql(model, 'StockMove')).toBe(
      [
        '-- "public"."StockMove"',
        'ALTER TABLE "public"."StockMove" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "public"."StockMove" FORCE ROW LEVEL SECURITY;',
        `DO $$ DECLARE existing record; BEGIN FOR existing IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'StockMove' LOOP EXECUTE format('DROP POLICY %I ON %I.%I', existing.policyname, 'public', 'StockMove'); END LOOP; END $$;`,
        'REVOKE ALL ON TABLE "public"."StockMove" FROM PUBLIC, "floor_rt", "office_rt", "partner_rt";',
        'GRANT SELECT ("id", "qty", "siteId", "tenantId"), INSERT ("id", "qty", "siteId", "tenantId") ON TABLE "public"."StockMove" TO "floor_rt";',
        'GRANT SELECT, INSERT ON TABLE "public"."StockMove" TO "office_rt";',
        `CREATE POLICY "floor_rt_select" ON "public"."StockMove" AS PERMISSIVE FOR SELECT TO "floor_rt" USING ("siteId" = NULLIF(current_setting('example.site_id', true), '')::uuid AND "tenantId" = NULLIF(current_setting('example.tenant_id', true), '')::uuid);`,
        `CREATE POLICY "floor_rt_insert" ON "public"."StockMove" AS PERMISSIVE FOR INSERT TO "floor_rt" WITH CHECK ("siteId" = NULLIF(current_setting('example.site_id', true), '')::uuid AND "tenantId" = NULLIF(current_setting('example.tenant_id', true), '')::uuid);`,
        `CREATE POLICY "office_rt_select" ON "public"."StockMove" AS PERMISSIVE FOR SELECT TO "office_rt" USING ("tenantId" = NULLIF(current_setting('example.tenant_id', true), '')::uuid);`,
        `CREATE POLICY "office_rt_insert" ON "public"."StockMove" AS PERMISSIVE FOR INSERT TO "office_rt" WITH CHECK ("tenantId" = NULLIF(current_setting('example.tenant_id', true), '')::uuid);`,
        '',
      ].join('\n'),
    )
  })

  it('gives each command its own clause: UPDATE checks old and new rows, DELETE keeps a table grant beside column grants', () => {
    const sql = tablePolicySql(
      { ...model, tables: [{ ...quote, access: { partner_rt: { privileges: ['update', 'delete'], scopedBy: ['party'], hiddenColumns: ['margin'] } } }] },
      'Quote',
    )
    expect(sql).toContain('GRANT UPDATE ("id", "note", "partyId", "tenantId", "total") ON TABLE "public"."Quote" TO "partner_rt";')
    expect(sql).toContain('GRANT DELETE ON TABLE "public"."Quote" TO "partner_rt";')
    expect(sql).toMatch(/FOR UPDATE TO "partner_rt" USING \(.+\) WITH CHECK \(.+\);/)
    expect(sql).toMatch(/FOR DELETE TO "partner_rt" USING \(.+\);/)
  })

  it('does not depend on the order of the input', () => {
    const shuffled: PolicyModel = {
      ...model,
      roles: [...model.roles].reverse(),
      tables: [
        { ...quote, columns: [...quote.columns].reverse(), access: { partner_rt: quote.access.partner_rt!, office_rt: quote.access.office_rt! } },
        { ...stockMove, access: { floor_rt: { ...stockMove.access.floor_rt!, privileges: ['select', 'insert'] }, office_rt: stockMove.access.office_rt! } },
      ],
    }
    expect(policySql(shuffled)).toBe(policySql(model))
  })

  it('starts with USAGE on each schema and lists tables by schema and name', () => {
    const sql = policySql(model)
    expect(sql.startsWith('GRANT USAGE ON SCHEMA "public" TO "floor_rt", "office_rt", "partner_rt";\n-- "public"."Quote"\n')).toBe(true)
    expect(sql.indexOf('-- "public"."Quote"')).toBeLessThan(sql.indexOf('-- "public"."StockMove"'))
    expect(tablePolicySql(model, 'Quote')).toBe(sql.slice(sql.indexOf('-- "public"."Quote"'), sql.indexOf('-- "public"."StockMove"')))
  })

  it.each<[string, PolicyModel]>([
    ['no managed role', { ...model, roles: [] }],
    ['a role with capitals', { ...model, roles: ['Office'] }],
    ['no wall', { ...model, alwaysScopedBy: [] }],
    ['a wall key that does not exist', { ...model, alwaysScopedBy: ['company'] }],
    ['a setting with a quote', { ...model, keys: { ...model.keys, tenant: { setting: "x.t'", type: 'uuid' } } }],
    ['a type with SQL in it', { ...model, keys: { ...model.keys, tenant: { setting: 'x.t', type: 'uuid); DROP TABLE x; --' } } }],
    ['a table name with a quote', { ...model, tables: [{ ...stockMove, table: 'Stock"Move' }] }],
    ['a table listed twice', { ...model, tables: [stockMove, stockMove] }],
    ['a table without columns', { ...model, tables: [{ ...stockMove, columns: [] }] }],
    ['a key column that is not a column', { ...model, tables: [{ ...stockMove, keyColumns: { tenant: 'tenant' } }] }],
    ['a table without the wall column', { ...model, tables: [{ ...stockMove, keyColumns: { site: 'siteId' } }] }],
    ['a role scoped by a key the table lacks', { ...model, tables: [{ ...quote, access: { floor_rt: { privileges: ['select'], scopedBy: ['site'] } } }] }],
    ['an unmanaged role', { ...model, tables: [{ ...stockMove, access: { stranger: { privileges: ['select'] } } }] }],
    ['a role without privileges', { ...model, tables: [{ ...stockMove, access: { office_rt: { privileges: [] } } }] }],
    ['an unknown privilege', { ...model, tables: [{ ...stockMove, access: { office_rt: { privileges: ['truncate' as never] } } }] }],
    ['a hidden column that is not a column', { ...model, tables: [{ ...stockMove, access: { floor_rt: { privileges: ['select'], hiddenColumns: ['cost'] } } }] }],
    ['hiding the column the policy reads', { ...model, tables: [{ ...stockMove, access: { floor_rt: { privileges: ['select'], hiddenColumns: ['tenantId'] } } }] }],
    ['a table that grants nothing', { ...model, tables: [{ ...stockMove, access: {} }] }],
  ])('refuses a model with %s', (_label, bad) => {
    expect(() => policySql(bad)).toThrow(PolicyModelError)
  })

  it('refuses a table the model does not have', () => {
    expect(() => tablePolicySql(model, 'Missing')).toThrow(PolicyModelError)
  })
})

describe('runtimeRoleSql and lockSetConfigSql', () => {
  it('creates missing roles and raises for a role that can log in or bypass', () => {
    const sql = runtimeRoleSql(['office_rt', 'floor_rt'])
    expect(sql.indexOf("rolname = 'floor_rt'")).toBeLessThan(sql.indexOf("rolname = 'office_rt'"))
    expect(sql).toContain('CREATE ROLE "office_rt" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;')
    expect(sql).toContain('rolcanlogin OR rolsuper OR rolbypassrls')
    expect(() => runtimeRoleSql(['bad role'])).toThrow(PolicyModelError)
  })

  it('takes set_config from PUBLIC and the runtime roles and gives it to the logins', () => {
    expect(lockSetConfigSql(['app_login'], ['office_rt', 'floor_rt'])).toBe(
      'REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC, "floor_rt", "office_rt";\n' +
        'GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO "app_login";\n',
    )
    expect(() => lockSetConfigSql([], ['office_rt'])).toThrow(PolicyModelError)
  })
})
