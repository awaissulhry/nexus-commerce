import { describe, it, expect } from 'vitest'
import { compileFormula } from './ads-metric-formula.js'

const REGISTRY = new Map<string, string>([
  ['sales', 'SUM(p."sales7dCents")/100.0'],
  ['cost', 'SUM(p."costMicros")/1000000.0'],
  ['clicks', 'SUM(p."clicks")'],
])
const compile = (f: string) => compileFormula(f, REGISTRY)

describe('custom-metric formula compiler', () => {
  it('composes AGGREGATES, not per-row arithmetic', () => {
    const { sql, error } = compile('sales - cost')
    expect(error).toBeNull()
    // SUM(a) - SUM(b), never SUM(a - b): those differ as soon as a group spans rows.
    expect(sql).toContain('SUM(p."sales7dCents")')
    expect(sql).toContain('SUM(p."costMicros")')
    expect(sql).not.toMatch(/SUM\([^)]*-[^)]*SUM/)
  })

  it('guards every division against a zero divisor', () => {
    const { sql } = compile('(sales - cost) / clicks')
    expect(sql).toContain('NULLIF(')
  })

  it('honours operator precedence', () => {
    const { sql } = compile('sales - cost * 2')
    expect(sql).toBe('((SUM(p."sales7dCents")/100.0)::numeric - ((SUM(p."costMicros")/1000000.0)::numeric * 2))')
  })

  it('supports unary minus and nesting', () => {
    expect(compile('-cost').error).toBeNull()
    expect(compile('((sales))').error).toBeNull()
  })

  it('casts to numeric so integer division does not truncate', () => {
    expect(compile('clicks / sales').sql).toContain('::numeric')
  })

  it('reports which metrics a formula uses', () => {
    expect(compile('sales - cost').usedMetrics.sort()).toEqual(['cost', 'sales'])
  })

  // ── refusals ────────────────────────────────────────────────────────────
  it.each([
    ['unknown identifier', 'sales - profit'],
    ['a constant alone', '1 + 2'],
    ['empty', '   '],
    ['unbalanced bracket', '(sales - cost'],
    ['stray closing bracket', 'sales)'],
    ['trailing operator', 'sales -'],
    ['trailing input', 'sales cost'],
  ])('rejects %s', (_label, formula) => {
    const { sql, error } = compile(formula)
    expect(sql).toBeNull()
    expect(error).not.toBeNull()
  })

  // The whole point: operator text reaches a SQL query, so nothing but metric
  // ids, numbers, ( ) and + - * / may survive tokenisation.
  it.each([
    ["statement break", 'sales; DROP TABLE "Campaign"'],
    ['comment', 'sales -- rest'],
    ['block comment', 'sales /* x */ - cost'],
    ['quoted string', "sales + 'x'"],
    ['double-quoted identifier', 'sales + "Campaign"'],
    ['function call', 'sales + version()'],
    ['subquery', 'sales + (SELECT 1)'],
    ['union', 'sales UNION SELECT 1'],
    ['backslash', 'sales \\ cost'],
    ['percent', 'sales % cost'],
    ['dollar quoting', 'sales + $$x$$'],
  ])('refuses injection via %s', (_label, formula) => {
    const { sql, error } = compile(formula)
    expect(sql).toBeNull()
    expect(error).not.toBeNull()
  })

  it('never emits anything but registry SQL, numbers and operators', () => {
    const { sql } = compile('(sales - cost) / clicks + 1')
    const stripped = sql!
      .replace(/SUM\(p\."[a-zA-Z0-9]+"\)/g, 'M')
      .replace(/NULLIF|::numeric/g, '')
    expect(stripped).not.toMatch(/[;'`]|--|\/\*|SELECT|UNION|DROP/i)
  })
})
