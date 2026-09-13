// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import ts from 'typescript'
import type { StudioCellValue as MasterCell } from './master/types'
import type { StudioCellValue as ChannelCell } from './channel/types'

const root = resolve(process.cwd(), '../..')
function properties(file: string, name: string): Map<string, string | undefined> {
  file = resolve(root, file)
  const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const node = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === name)
  if (!node) throw new Error(`Missing ${name} in ${file}`)
  return new Map(node.members.filter(ts.isPropertySignature).map(member => {
    const raw = member.type?.getText(source) ?? ''
    const imported = raw.match(/^import\(['"](.+)['"]\)\.(\w+)\[['"](\w+)['"]\]$/)
    const signature = imported ? properties(resolve(dirname(file), imported[1]).replace(/\.js$/, '.ts'), imported[2]).get(imported[3])
      : raw.split('|').map(s => s.trim()).sort().join('|')
    return [member.name.getText(source), signature] as const
  }))
}
describe('LX.12 canonical language wire mirrors', () => {
  it('both hosts carry the server canonical resolver facts and omit the previous spellings', () => {
    const server = properties('apps/api/src/services/pim/studio-sheet.service.ts', 'StudioCellValue')
    for (const host of ['master', 'channel']) {
      const mirror = properties(`apps/web/src/app/products/[id]/edit/_studio/sheet/${host}/types.ts`, 'StudioCellValue')
      for (const key of ['tier', 'requested', 'language', 'provenance', 'translation']) {
        expect(server.has(key), `Server field ${key}`).toBe(true)
        expect(mirror.get(key), `${host}.${key}`).toBe(server.get(key))
      }
      for (const key of ['requestedLocale', 'effectiveLocale', 'translationState', 'needsTranslation']) expect(mirror.has(key)).toBe(false)
    }
  })
  it('refuses any new field present on just one sheet mirror', () => {
    // Existing scope-specific fields are explicit exemptions; a new one must be reviewed here.
    const exemptions = {
      StudioCellValue: { masterOnly: [], channelOnly: ['affectsAllChannels', 'nexusDraft', 'resettable', 'shopifyWrite', 'writable', 'writeBlockedReason', 'writeVerb'] },
      SheetColumn: { masterOnly: ['axis'], channelOnly: ['shopifyField'] },
    }
    for (const [name, allowed] of Object.entries(exemptions)) {
      const master = properties('apps/web/src/app/products/[id]/edit/_studio/sheet/master/types.ts', name)
      const channel = properties('apps/web/src/app/products/[id]/edit/_studio/sheet/channel/types.ts', name)
      expect({ masterOnly: [...master.keys()].filter(k => !channel.has(k)).sort(),
        channelOnly: [...channel.keys()].filter(k => !master.has(k)).sort() }, name).toEqual(allowed)
    }
  })
  it('the two mirrors preserve common value, inheritance and list facts', () => {
    const master = properties('apps/web/src/app/products/[id]/edit/_studio/sheet/master/types.ts', 'StudioCellValue')
    const channel = properties('apps/web/src/app/products/[id]/edit/_studio/sheet/channel/types.ts', 'StudioCellValue')
    for (const key of ['value', 'inheritedFrom', 'inherited', 'pinned', 'follows', 'editable', 'linkGroupId']) {
      expect(master.has(key), key).toBe(true)
      expect(channel.get(key), key).toBe(master.get(key))
    }
  })
  it('both source mirrors accept the following snapshot without turning it into a pin', () => {
    const source: MasterCell['source'] & ChannelCell['source'] = 'channelSnapshot'
    const facts: Pick<MasterCell, 'source' | 'follows' | 'pinned' | 'value'> & Pick<ChannelCell, 'source' | 'follows' | 'pinned' | 'value'> = { source, follows:true, pinned:false, value:[] }
    expect(facts).toEqual({ source:'channelSnapshot', follows:true, pinned:false, value:[] })
  })
  it('server and both hosts inherit one shared ContentWriteFacts contract', () => {
    // The four members, read off `ContentWriteFacts` itself.
    const sharedSource = ts.createSourceFile('content-language.ts', readFileSync(resolve(root, 'packages/shared/content-language.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    const facts = sharedSource.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'ContentWriteFacts')!
    const sharedMembers = facts.members.filter(ts.isPropertySignature).map(member => member.name.getText(sharedSource))
    for (const file of ['apps/api/src/services/pim/studio-sheet.service.ts', ...['master','channel'].map(host => `apps/web/src/app/products/[id]/edit/_studio/sheet/${host}/types.ts`)]) {
      const source = ts.createSourceFile(file, readFileSync(resolve(root,file),'utf8'), ts.ScriptTarget.Latest, true)
      const binding = source.statements.filter(ts.isImportDeclaration)
        .filter(node => (node.moduleSpecifier as ts.StringLiteral).text === '@nexus/shared/content-language')
        .flatMap(node => {
          const bindings = node.importClause?.namedBindings
          return bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : []
        }).find(node => (node.propertyName?.text ?? node.name.text) === 'ContentWriteFacts')
      expect(binding, file).toBeDefined()
      const declaration = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === 'StudioCellValue')!
      expect(declaration.heritageClauses?.flatMap(clause => clause.types.map(type => type.expression.getText(source))), file).toContain(binding!.name.text)
      // LX.F P3-22c — the member list is DERIVED from the shared contract, not retyped.
      // It used to name three of the four, and the missing one was `contentAcknowledged`
      // — the boolean the server's acknowledgement gate reads
      // (`content-bulk-write.ts`, `change.contentAcknowledged !== true`) and both
      // clients set. A field redeclared locally on BOTH mirrors with divergent types
      // passed every test here, because the derived set-diff above only catches a field
      // present on ONE side.
      expect(sharedMembers).toContain('contentAcknowledged')
      expect(sharedMembers.length).toBeGreaterThanOrEqual(4)
      const redeclared = declaration.members.filter(member => ts.isPropertySignature(member) && sharedMembers.includes(member.name.getText(source))).map(member => member.name!.getText(source))
      expect(redeclared, `${file} redeclares shared ContentWriteFacts members`).toEqual([])
    }
  })

})
