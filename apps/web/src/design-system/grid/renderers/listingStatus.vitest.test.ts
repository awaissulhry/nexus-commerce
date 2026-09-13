import { expect, it } from 'vitest'
import { listingStatusMeta, LISTING_STATUSES } from './listingStatus'
it('normalises provider case without claiming channel verification', () => {
 for (const raw of ['ACTIVE','Active','active',' LIVE ']) expect(listingStatusMeta(raw)).toMatchObject({ label: 'Listed', tone: 'info' })
 expect(listingStatusMeta('Completed').label).toBe('Ended')
 expect(listingStatusMeta('ARCHIVED').label).toBe('Archived')
 expect(listingStatusMeta('future-token')).toMatchObject({ label: 'future-token', tone: 'neutral' })
 expect(listingStatusMeta(null).label).toBe('Not recorded')
 for (const s of LISTING_STATUSES) expect(listingStatusMeta(s).tone).not.toBe('success')
})

// Re-derive literal and conditional status writes; ordering metadata is a positive exclusion control.
import ts from 'typescript'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
function emittedStatuses(text: string) {
 const sf = ts.createSourceFile('writer.ts', text, ts.ScriptTarget.Latest, true)
 const found = new Set<string>()
 const visit = (n: ts.Node) => {
  if (ts.isPropertyAssignment(n) && n.name.getText(sf).replace(/['"]/g, '') === 'listingStatus' && !ts.isObjectLiteralExpression(n.initializer)) {
   let order = false
   for (let a: ts.Node | undefined = n.parent; a; a = a.parent) {
    if (ts.isPropertyAssignment(a) && a.name.getText(sf) === 'orderBy') { order = true; break }
    if (ts.isCallExpression(a)) break
   }
   if (!order) {
    const collect = (i: ts.Expression) => {
     if (ts.isStringLiteral(i) && /^[a-z_ -]+$/i.test(i.text)) found.add(i.text.toUpperCase())
     if (ts.isConditionalExpression(i)) { collect(i.whenTrue); collect(i.whenFalse) }
    }
    collect(n.initializer)
   }
  }
  ts.forEachChild(n, visit)
 }
 visit(sf)
 return found
}
it('covers the vocabulary currently emitted by API source writers, without treating orderBy as a status', () => {
 expect([...emittedStatuses("write({ orderBy: { listingStatus: 'asc' }, data: { listingStatus: active ? 'ACTIVE' : 'INACTIVE' } })")].sort()).toEqual(['ACTIVE','INACTIVE'])
 const walk = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(root, e.name)) : e.name.endsWith('.ts') && !e.name.includes('.test.') ? [join(root, e.name)] : [])
 const files = walk(fileURLToPath(new URL('../../../../../api/src', import.meta.url)))
 expect(files.length).toBeGreaterThan(100)
 const emitted = new Set(files.flatMap(file => [...emittedStatuses(readFileSync(file, 'utf8'))]))
 expect(emitted.has('DRAFT')).toBe(true); expect(emitted.has('SUPPRESSED')).toBe(true)
 for (const status of emitted) expect(LISTING_STATUSES, `Writer added ${status}; review its canonical words and tone`).toContain(status)
})
