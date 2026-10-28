import { describe, expect, it } from 'vitest'
import { TenantScopeError } from './scope'
import { checkStatement } from './sql-guard'

describe('checkStatement', () => {
  it.each([
    'SELECT 1',
    'select * from "public"."Item" where "id" = $1',
    'SELECT 1;',
    '  /* traceparent=00-abc */ SELECT 1  ',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'INSERT INTO "public"."Item" ("id", "name") VALUES ($1, $2) RETURNING "id"',
    'INSERT INTO t (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET a = excluded.a',
    'UPDATE "public"."Item" SET "name" = $1 WHERE "id" = $2',
    'DELETE FROM "public"."Item" WHERE "id" = $1',
    "SELECT COALESCE(JSONB_AGG(x), '[]') FROM t",
    "SELECT 'it''s set_config and reset role; and $$' AS text",
    "SELECT E'a\\'b' AS text",
    'SELECT "a$b", a$1 FROM t',
    "SELECT 'a' -- set_config('role', 'x', true)\n",
    'SELECT /* nested /* set_config */ still comment */ 1',
    'SELECT pg_advisory_xact_lock($1)',
    'SELECT current_setting($1, true)',
    'WITH moved AS (INSERT INTO a SELECT * FROM b RETURNING *) SELECT count(*) FROM moved',
    'SELECT x FROM "lotNumber" JOIN "Location" ON true',
  ])('accepts a plain query: %s', (sql) => {
    expect(checkStatement(sql)).toBe('query')
  })

  it.each(['COMMIT', 'commit;', ' ROLLBACK '])('reports transaction control: %s', (sql) => {
    expect(checkStatement(sql)).toBe(sql.trim().toLowerCase().replace(';', ''))
  })

  it.each([
    ['an empty statement', ''],
    ['only a comment', '-- nothing'],
    ['SET ROLE', 'SET ROLE postgres'],
    ['SET LOCAL of a scope setting', "SET LOCAL factory.tenant_id = 'b'"],
    ['RESET', 'RESET ROLE'],
    ['DISCARD', 'DISCARD ALL'],
    ['BEGIN', 'BEGIN'],
    ['a savepoint', 'SAVEPOINT a'],
    ['COMMIT with more', 'COMMIT AND CHAIN'],
    ['DDL', 'CREATE TABLE x (id int)'],
    ['TRUNCATE', 'TRUNCATE "Item"'],
    ['COPY', 'COPY t TO STDOUT'],
    ['DO', "DO $$ BEGIN PERFORM set_config('role', 'x', true); END $$"],
    ['EXPLAIN', 'EXPLAIN ANALYZE SELECT 1'],
    ['a second statement', 'SELECT 1; SELECT 2'],
    ['a second statement after a trailing comment', 'SELECT 1; -- x\nSET ROLE x'],
    ['set_config', "SELECT set_config('factory.tenant_id', 'b', true)"],
    ['set_config, schema-qualified', "SELECT pg_catalog.set_config('role', 'x', true)"],
    ['set_config as a quoted identifier', `SELECT "set_config"('role', 'x', true)`],
    ['set_config inside a CTE', "WITH x AS (SELECT set_config('role', 'x', true)) SELECT 1"],
    ['set_config in an UPDATE', "UPDATE t SET a = set_config('role', 'x', true)"],
    ['an UPDATE of pg_settings', "UPDATE pg_settings SET setting = 'b' WHERE name = 'factory.tenant_id'"],
    ['query_to_xml (runs a query from a string)', "SELECT query_to_xml('SELECT 1', true, true, '')"],
    ['ts_stat (runs a query from a string)', "SELECT * FROM ts_stat('SELECT v FROM t')"],
    ['ts_rewrite', "SELECT ts_rewrite('a'::tsquery, 'SELECT 1')"],
    ['large objects', 'SELECT lo_create(0)'],
    ['dblink', "SELECT * FROM dblink('host=x', 'SELECT 1') AS t(a int)"],
    ['SELECT INTO a temporary table', 'SELECT * INTO TEMP copy FROM "Item"'],
    ['SELECT INTO', 'SELECT * INTO pg_temp.copy FROM "Item"'],
    ['MERGE INTO', 'WITH s AS (SELECT 1) MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE'],
    ['a dollar-quoted string', 'SELECT $$text$$'],
    ['a tagged dollar quote', 'SELECT $q$text$q$'],
    ['a Unicode-escaped identifier', 'SELECT U&"\\0073et_config"(\'role\', \'x\', true)'],
    ['a Unicode-escaped string', "SELECT U&'\\0041'"],
    ['an unterminated string', "SELECT 'abc"],
    ['an unterminated comment', 'SELECT 1 /* open'],
    ['an unterminated nested comment', 'SELECT 1 /* a /* b */'],
    ['an unterminated quoted identifier', 'SELECT "abc'],
    ['a keyword in quotes', '"SELECT" 1'],
  ])('refuses %s', (_label, sql) => {
    expect(() => checkStatement(sql)).toThrow(TenantScopeError)
  })

  it('refuses with the statement_refused code', () => {
    try {
      checkStatement('SET ROLE postgres')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(TenantScopeError)
      expect((error as TenantScopeError).code).toBe('statement_refused')
    }
  })

  describe('cannot be fooled into reading code as a literal', () => {
    it.each([
      // PostgreSQL nests block comments: the server sees `set_config(…)` as code after the second `*/`.
      ['a nested comment hiding a quote', "/* /* */ ' */ SELECT set_config('role', 'x', true) --'"],
      // E'\'' is ONE quote character for the server; a reader without E-strings would see a literal swallow the call.
      ['an E-string escape', "SELECT E'\\'' , set_config('role','x',true) --'"],
      // With standard_conforming_strings off, '\'' is one quote character too.
      ['a backslash in a plain string', "SELECT 'a\\'' , set_config('role','x',true) --'"],
      // Dollar quotes are refused outright: a reader without them would see a literal swallow the call.
      ['a dollar quote hiding a quote', "SELECT $$'$$, set_config('role','x',true), $$'$$"],
    ])('%s', (_label, sql) => {
      expect(() => checkStatement(sql)).toThrow(TenantScopeError)
    })

    it('a statement must be safe under BOTH string settings', () => {
      // Standard strings on: 'a\' and ';' are literals, the rest a comment: one harmless query. Off: 'a\', 1, ' is one
      // literal and the `;` after it is code, so a second statement could follow. Refused.
      expect(() => checkStatement("SELECT 'a\\', 1, ';' --'")).toThrow(/more than one statement/)
    })
  })
})
