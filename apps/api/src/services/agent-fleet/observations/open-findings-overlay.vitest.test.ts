/**
 * NAF.WF7.a — the test lane's evidence overlay.
 *
 * The merge is pure, so it is tested to exhaustion here and prod is left to
 * confirm exactly one thing: that a director's preview changed because the
 * overlay was there. That split is deliberate — a council-shaped test walk
 * costs real money, and every case below is free.
 *
 * The properties that matter are safety properties: the overlay must never
 * lose what is already on the board, never claim a real finding id, and never
 * throw on the shapes a model can produce.
 */

import { describe, expect, it } from 'vitest'
import { overlayPreviewFindings, type PreviewOverlayFinding } from './open-findings.observation.js'

const boardFinding = (id: string) => ({
  findingId: id, charter: 'amazon-negative-miner', kind: 'waste_term',
  entityType: 'SEARCH_TERM', entityId: 'e1', entityName: null,
  severity: 'high', confidence: 0.8, observation: {}, rationale: 'r',
  engineAgrees: true, engineDisagreement: null,
})
const payload = (n: number) => ({
  scope: 'account',
  counts: { openTotal: n, shown: n, trimmed: 0 },
  caveats: ['existing caveat'],
  toolContracts: [{ tool: 'set-target-bid' }],
  findings: Array.from({ length: n }, (_, i) => boardFinding(`board-${i}`)),
})
const ov = (charterKey: string, over: Record<string, unknown> = {}): PreviewOverlayFinding => ({
  charterKey,
  finding: {
    kind: 'harvest_candidate', entityType: 'SEARCH_TERM', entityId: 'kw-1',
    entityName: 'motorrad jacke', severity: 'medium', confidence: 0.6,
    observation: { clicks: 12 }, rationale: 'earns', ...over,
  },
})

describe('overlayPreviewFindings (WF7.a)', () => {
  it('returns the payload untouched when there is no overlay', () => {
    const p = payload(2)
    expect(overlayPreviewFindings(p, undefined)).toBe(p)
    expect(overlayPreviewFindings(p, [])).toBe(p)
  })

  it('merges would-be findings ahead of the board without losing any', () => {
    const out = overlayPreviewFindings(payload(2), [ov('a'), ov('b')]) as Record<string, unknown>
    const findings = out.findings as Record<string, unknown>[]
    expect(findings).toHaveLength(4)
    expect(findings.slice(0, 2).every((f) => f.wouldBe === true)).toBe(true)
    expect(findings.slice(2).map((f) => f.findingId)).toEqual(['board-0', 'board-1'])
  })

  it('never claims a real finding id — every would-be id is namespaced', () => {
    const out = overlayPreviewFindings(payload(1), [ov('amazon-negative-miner'), ov('x')]) as Record<string, unknown>
    const ids = (out.findings as Record<string, unknown>[]).filter((f) => f.wouldBe).map((f) => f.findingId)
    expect(ids).toEqual(['preview:amazon-negative-miner:0', 'preview:x:1'])
    expect(ids.every((i) => String(i).startsWith('preview:'))).toBe(true)
  })

  it('tells the model what it is looking at, without dropping existing caveats', () => {
    const out = overlayPreviewFindings(payload(1), [ov('a')]) as Record<string, unknown>
    const caveats = out.caveats as string[]
    expect(caveats[0]).toBe('existing caveat')
    expect(caveats.at(-1)).toContain('not on the board')
    expect(caveats.at(-1)).toContain('preview:')
    expect((out.counts as Record<string, unknown>).wouldBe).toBe(1)
  })

  it('keeps every other key of the payload — tool contracts especially', () => {
    const out = overlayPreviewFindings(payload(1), [ov('a')]) as Record<string, unknown>
    expect(out.scope).toBe('account')
    expect(out.toolContracts).toEqual([{ tool: 'set-target-bid' }])
    expect((out.counts as Record<string, unknown>).openTotal).toBe(1)
  })

  it('merges into an empty board — the case a first-ever test hits', () => {
    const out = overlayPreviewFindings(payload(0), [ov('a')]) as Record<string, unknown>
    expect((out.findings as unknown[])).toHaveLength(1)
  })

  it('never throws on shapes a model can produce', () => {
    const bad = [
      null, undefined, 0, 'x', [], { findings: 'nope' }, { counts: null }, { caveats: 'no' },
    ]
    for (const p of bad) expect(() => overlayPreviewFindings(p, [ov('a')])).not.toThrow()
    for (const f of [{}, { kind: 1 }, { severity: null }, { confidence: 'high' }]) {
      expect(() => overlayPreviewFindings(payload(1), [{ charterKey: 'a', finding: f as never }])).not.toThrow()
    }
  })

  it('substitutes safe defaults rather than passing junk to the model', () => {
    const out = overlayPreviewFindings(payload(0), [
      { charterKey: 'a', finding: { confidence: 'high', kind: 7 } as never },
    ]) as Record<string, unknown>
    const f = (out.findings as Record<string, unknown>[])[0]!
    expect(f.confidence).toBe(0)
    expect(f.kind).toBe('')
    expect(f.severity).toBe('info')
  })

  it('a non-analyst tier contributes nothing rather than a malformed row', () => {
    // A director/critic preview stores one artifact, not a findings array —
    // `workflow-test.service` only pushes objects, so the overlay is empty.
    const out = overlayPreviewFindings(payload(2), []) as Record<string, unknown>
    expect((out as { findings: unknown[] }).findings).toHaveLength(2)
  })
})
