/**
 * PES.4 — the `RestorePoint` mirror, pinned against the API file it mirrors.
 *
 * This lane has shipped four wrong type mirrors (a `MasterCompleteness` shape, `listing`/`readiness`
 * read as maps when they are singular, two required fields typed optional). Every one typechecked,
 * every one was reviewed, and each was found only by running the thing. So a mirror gets a test
 * that reads the SOURCE, and the extractor throws rather than returning empty — a contract test
 * that silently finds nothing to compare is the failure mode it exists to prevent.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pimFile } from './api-source.testutil'
import { notRestorablePointReason, type RestorePoint } from './useRestorePoints'

/** Pull one `export interface X { … }` body out of the service, brace-matched. */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`)
  if (start < 0) throw new Error(`interface ${name} not found — renamed in the API?`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`interface ${name} is unbalanced — the extractor cannot trust this file`)
}

/** Top-level member names, ignoring comments and nested object literals. */
function members(body: string): string[] {
  const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'))
  const out: string[] = []
  let depth = 0
  for (const raw of inner.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) continue
    if (depth === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line)
      if (m) out.push(m[1])
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
  }
  if (out.length === 0) throw new Error('extractor found no members — it is broken, not the type')
  return out
}

const SOURCE = readFileSync(pimFile('restore-points.service.ts'), 'utf8')

describe('RestorePoint mirrors the API', () => {
  it('carries every member the service declares', () => {
    const api = members(interfaceBody(SOURCE, 'RestorePoint'))
    expect(api.length).toBeGreaterThan(4)
    // Compile-time mirror, asserted at runtime against the source of truth.
    const mine: Record<keyof RestorePoint, true> = {
      at: true, action: true, actor: true, fields: true, restorableFields: true,
      restorable: true, restoreVia: true, formula: true, layer: true,
    }
    expect(Object.keys(mine).sort()).toEqual(api.sort())
  })

  it('carries the coverage block, which is what makes "0 points" explainable', () => {
    const api = members(interfaceBody(SOURCE, 'RestorePointsResult'))
    expect(api).toContain('coverage')
    expect(api).toContain('points')
  })

  it('the service really does distinguish unreadable rows from event rows', () => {
    // Both counters must exist: collapsing them would hide the 320-row map-shape class.
    expect(SOURCE).toContain('unreadableRowsExcluded')
    expect(SOURCE).toContain('eventRowsExcluded')
  })
})

const point = (over: Partial<RestorePoint> = {}): RestorePoint => ({
  at: '2026-09-01T10:00:00.000Z', action: 'update', actor: 'someone',
  fields: ['name'], restorableFields: ['name'], restorable: true,
  restoreVia: 'master', layer: 'master', ...over,
})

describe('notRestorablePointReason', () => {
  it('is silent for a restorable point', () => {
    expect(notRestorablePointReason(point())).toBeNull()
  })

  it('explains an event row, which has no fields at all', () => {
    const r = notRestorablePointReason(point({ restorable: false, fields: [], restorableFields: [] }))
    expect(r).toMatch(/records an event/)
  })

  it('names the fields that changed rather than saying only "not restorable"', () => {
    const r = notRestorablePointReason(
      point({ restorable: false, fields: ['attr_material', 'de.description'], restorableFields: [] }),
    )
    expect(r).toContain('attr_material')
    expect(r).toContain('de.description')
  })

  it('truncates a long field list but says how many were left out', () => {
    const r = notRestorablePointReason(
      point({ restorable: false, fields: ['a', 'b', 'c', 'd', 'e'], restorableFields: [] }),
    )
    expect(r).toContain('and 2 more')
  })

  it('never re-decides restorability — it reports the server’s verdict', () => {
    // A point the server calls restorable gets no reason even with unrestorable-looking fields.
    expect(notRestorablePointReason(point({ fields: ['attr_material'] }))).toBeNull()
  })
})

describe('🔴 formula points route to their own verb (#488)', () => {
  const formula = point({
    action: 'formula.pinned', restoreVia: 'formula', restorable: true,
    fields: ['attr_color'], restorableFields: [],
    formula: { auditLogId: 'al_1', fieldKey: 'attr_color', expr: '=A1*2' },
  })

  it('is offered — the refusal existed only while the point carried no id', () => {
    expect(notRestorablePointReason(formula)).toBeNull()
  })

  it('🔴 a formula point WITHOUT its payload is refused, not fallen through to the master path', () => {
    // The server should never emit this. If it does, the failure must not be a master-field write.
    const orphan = point({ restoreVia: 'formula', restorable: true, formula: undefined })
    expect(notRestorablePointReason(orphan)).toMatch(/missing the record/)
  })

  it('a master point is unaffected', () => {
    expect(notRestorablePointReason(point())).toBeNull()
  })

  it('the verdict comes from restoreVia, never from the action name', () => {
    // Same action string, server says master → this pane must not second-guess it.
    const m = point({ action: 'formula.pinned', restoreVia: 'master' })
    expect(notRestorablePointReason(m)).toBeNull()
  })

  it('the pane routes on restoreVia rather than parsing the action', () => {
    const src = readFileSync(new URL('./panes/RestoreMode.tsx', import.meta.url), 'utf8')
    expect(src).toContain("point.restoreVia === 'formula' ? onPickFormula(point) : onPick(point.at)")
    expect(src).not.toMatch(/action === .formula\.pinned./)
  })
})
