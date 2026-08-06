/**
 * NAF.A — contract tests for the fleet artifact schemas (docs/AGENT_FLEET.md
 * Part 5). One minimal valid fixture per schema, plus the floors the brief
 * makes load-bearing: no evidence ⇒ no finding, confidence is 0..1, and a
 * rationale under 20 chars is not a rationale.
 */
import { describe, expect, it } from 'vitest'
import {
  AnalystOutput,
  CriticOutput,
  DirectorOutput,
  ExpectedEffect,
  Finding,
  OUTPUT_SCHEMAS,
  PlanItem,
} from './agent-fleet.js'

const validEffect = {
  metric: 'acos',
  direction: 'decrease',
  magnitudePct: 12,
  horizonDays: 14,
  basis: 'break-even ACOS from ads-target-acos over 30d window',
}

const validFinding = {
  entityType: 'COMPONENT',
  entityId: 'cron:ads-tos-is-ingest',
  kind: 'cron_failing',
  severity: 'high',
  confidence: 0.92,
  observation: { failures: 9, runs: 9 },
  evidenceRefs: ['obs_cron_health_1'],
  dataVintage: '2026-08-06T04:00:00.000Z',
  rationale:
    'Nine consecutive failures in 24h with zero successes; the job is broken, not flaky.',
  dedupeKey: 'cron_failing:ads-tos-is-ingest',
  expiresInHours: 48,
}

const validPlanItem = {
  findingId: 'fnd_1',
  rank: 1,
  tool: 'set-negative-keyword',
  args: { campaignId: 'c1', term: 'giacca pelle' },
  expectedEffect: validEffect,
  reversible: true,
}

describe('ExpectedEffect', () => {
  it('parses a minimal valid effect', () => {
    expect(ExpectedEffect.safeParse(validEffect).success).toBe(true)
  })
  it('rejects a magnitude above 500%', () => {
    expect(
      ExpectedEffect.safeParse({ ...validEffect, magnitudePct: 501 }).success,
    ).toBe(false)
  })
  it('rejects a basis too short to cite a source', () => {
    expect(
      ExpectedEffect.safeParse({ ...validEffect, basis: 'vibes' }).success,
    ).toBe(false)
  })
})

describe('Finding', () => {
  it('parses a minimal valid finding', () => {
    const r = Finding.safeParse(validFinding)
    expect(r.success).toBe(true)
  })
  it('rejects empty evidenceRefs — no evidence, no finding', () => {
    expect(
      Finding.safeParse({ ...validFinding, evidenceRefs: [] }).success,
    ).toBe(false)
  })
  it('rejects confidence outside 0..1', () => {
    expect(
      Finding.safeParse({ ...validFinding, confidence: 1.2 }).success,
    ).toBe(false)
    expect(
      Finding.safeParse({ ...validFinding, confidence: -0.1 }).success,
    ).toBe(false)
  })
  it('rejects a rationale shorter than 20 chars', () => {
    expect(
      Finding.safeParse({ ...validFinding, rationale: 'looks broken' }).success,
    ).toBe(false)
  })
  it('rejects a non-ISO dataVintage', () => {
    expect(
      Finding.safeParse({ ...validFinding, dataVintage: 'yesterday' }).success,
    ).toBe(false)
  })
  it('rejects an unknown entityType', () => {
    expect(
      Finding.safeParse({ ...validFinding, entityType: 'WIDGET' }).success,
    ).toBe(false)
  })
})

describe('AnalystOutput', () => {
  it('parses a valid output and an empty findings list', () => {
    expect(
      AnalystOutput.safeParse({ findings: [validFinding], scanned: 113 })
        .success,
    ).toBe(true)
    expect(
      AnalystOutput.safeParse({ findings: [], scanned: 0 }).success,
    ).toBe(true)
  })
  it('rejects more than 50 findings', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      ...validFinding,
      entityId: `cron:job-${i}`,
    }))
    expect(
      AnalystOutput.safeParse({ findings: many, scanned: 51 }).success,
    ).toBe(false)
  })
  it('rejects a non-integer scanned', () => {
    expect(
      AnalystOutput.safeParse({ findings: [], scanned: 1.5 }).success,
    ).toBe(false)
  })
})

describe('DirectorOutput', () => {
  const valid = {
    headline: 'Cut waste on IT phrase match',
    narrative:
      'Two negative-keyword findings and one bid reduction survive dedupe; the rest fall below the evidence floor.',
    items: [validPlanItem],
    dropped: [{ findingId: 'fnd_2', reason: 'duplicate of fnd_1 on the same entity' }],
    conflicts: [],
    changeBudgetUsed: { entities: 1, valueCents: 0 },
  }
  it('parses a valid plan', () => {
    expect(DirectorOutput.safeParse(valid).success).toBe(true)
  })
  it('rejects a drop without a real reason', () => {
    expect(
      DirectorOutput.safeParse({
        ...valid,
        dropped: [{ findingId: 'fnd_2', reason: 'dup' }],
      }).success,
    ).toBe(false)
  })
  it('rejects a conflict citing fewer than two findings', () => {
    expect(
      DirectorOutput.safeParse({
        ...valid,
        conflicts: [
          {
            findingIds: ['fnd_1'],
            kind: 'same_entity',
            resolution: 'keep the higher-confidence finding',
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('PlanItem', () => {
  it('defaults dependsOn to []', () => {
    const r = PlanItem.parse(validPlanItem)
    expect(r.dependsOn).toEqual([])
  })
})

describe('CriticOutput', () => {
  const valid = {
    verdict: 'pass',
    checks: [
      { check: 'evidence_sufficient', result: 'pass' },
      { check: 'blast_radius_ok', result: 'n/a', note: 'no writes proposed' },
    ],
    summary: 'All checks pass; nothing blocked.',
  }
  it('parses a valid critique and defaults blockedItems/offendingItems', () => {
    const r = CriticOutput.parse(valid)
    expect(r.blockedItems).toEqual([])
    expect(r.checks[0]!.offendingItems).toEqual([])
  })
  it('rejects an unknown check name', () => {
    expect(
      CriticOutput.safeParse({
        ...valid,
        checks: [{ check: 'sounds_plausible', result: 'pass' }],
      }).success,
    ).toBe(false)
  })
})

describe('OUTPUT_SCHEMAS registry', () => {
  it('maps every key to a parseable schema', () => {
    expect(
      OUTPUT_SCHEMAS['analyst-output'].safeParse({ findings: [], scanned: 0 })
        .success,
    ).toBe(true)
    expect(OUTPUT_SCHEMAS['director-output']).toBe(DirectorOutput)
    expect(OUTPUT_SCHEMAS['critic-output']).toBe(CriticOutput)
  })
  it('rejects unknown keys at compile time', () => {
    // @ts-expect-error — 'strategist-output' is not a registered schema key
    const missing = OUTPUT_SCHEMAS['strategist-output']
    expect(missing).toBeUndefined()
  })
})
