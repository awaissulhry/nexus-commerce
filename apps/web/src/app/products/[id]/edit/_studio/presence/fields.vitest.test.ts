import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { syncQueueSourceSchema } from './types'
function members(path: URL, name: string) {
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const node = source.statements.find((n): n is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(n) && n.name.text === name)
  if (!node) throw new Error(`Interface ${name} was not found`)
  return new Map(node.members.filter(ts.isPropertySignature).map(m => [m.name.getText(source), `${m.questionToken ? '?' : ''}:${m.type?.getText(source).replace(/\s/g, '')}`]))
}
describe('additive presence projection mirror parity', () => {
  it('both studio carriers share the complete field contract', () => {
    for (const file of ['../drawer/types.ts', '../sheet/channel/types.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source).toContain('export interface SheetListing extends ListingPresenceFields')
      expect(source).toContain("presence/fields'")
    }
  })
  it('every additive field has the API producer’s optionality and nullability', () => {
    const expected = members(new URL('./fields.ts', import.meta.url), 'ListingPresenceFields')
    const api = members(new URL('../../../../../../../../api/src/services/pim/sheet-rows.service.ts', import.meta.url), 'SheetListing')
    expect(expected.size).toBe(6)
    for (const [key, type] of expected) expect(api.get(key), key).toBe(type)
  })
  it('source coverage preserves not-queried and rejects missing status', () => {
    expect(syncQueueSourceSchema.parse({ source: 'ListingIssue', queried: false, status: 'not-queried', sentence: 'Listing issues were not queried.' }).status).toBe('not-queried')
    expect(syncQueueSourceSchema.safeParse({ source: 'ListingIssue', queried: false, sentence: 'unknown' }).success).toBe(false)
    const source = readFileSync(new URL('../channel-ops/ErrorsSyncConsole.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Source coverage was not reported by this response.')
    expect(source).not.toContain('nothing recorded on this coordinate yet')
  })
})
