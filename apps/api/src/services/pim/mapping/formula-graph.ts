export interface FormulaNode {
  productId: string
  scope: string
  channel?: string | null
  marketplace?: string | null
  locale?: string | null
  channelConnectionId?: string | null
  aliasKey?: string | null
  fieldKey: string
  dependsOn: string[]
}

export const formulaScopeKey = (row: Omit<FormulaNode, 'fieldKey' | 'dependsOn'>): string =>
  JSON.stringify([row.productId, row.scope, row.channel || '', row.marketplace || '', row.locale || '', row.channelConnectionId || '', row.aliasKey || ''])
export const formulaCellKey = (row: Omit<FormulaNode, 'dependsOn'>): string =>
  JSON.stringify([formulaScopeKey(row), row.fieldKey])

/** References name fields in this coordinate, never a similarly named field in another locale. */
export function formulaGraph<T extends FormulaNode>(rows: readonly T[]) {
  const byCell = new Map(rows.map(row => [formulaCellKey(row), row]))
  const dependencies = (row: T): T[] => row.dependsOn.flatMap(fieldKey => {
    const source = byCell.get(formulaCellKey({ ...row, fieldKey }))
    return source ? [source] : []
  })
  const ordered: T[] = []
  const cycles = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []
  const visit = (row: T) => {
    const key = formulaCellKey(row)
    const at = stack.indexOf(key)
    if (at >= 0) { stack.slice(at).forEach(k => cycles.add(k)); return }
    if (done.has(key)) return
    stack.push(key)
    dependencies(row).forEach(visit)
    stack.pop()
    done.add(key)
    ordered.push(row)
  }
  // Master results must be persisted before a channel resolves inherited sources.
  [...rows].sort((a, b) => Number(a.scope === 'channel') - Number(b.scope === 'channel')).forEach(visit)
  return { ordered, cycles, dependencies }
}
