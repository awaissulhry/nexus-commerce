import { describe, expect, it } from 'vitest'
import { CHANNEL_FACTS, PRESENCE_INTENTS, PRESENCE_VERDICTS, factMeta, intentMeta, presenceLine, presenceVerdict, verdictMeta, type Presence } from './presence'

const at = '2026-09-13T12:00:00Z'
const current: Presence = { intent: 'LIVE', intentAt: at, fact: 'SELLING', observedAt: at, inFlight: false, now: Date.parse(at), freshnessMs: 60_000 }
describe('presence is distinct from readiness', () => {
  it('derives every named member from a complete table, including LIVE labelled Listed', () => {
    expect(PRESENCE_INTENTS).toEqual(['NONE', 'DRAFT', 'LIVE', 'HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'])
    expect(CHANNEL_FACTS).toEqual(['UNKNOWN', 'SELLING', 'NOT_SELLING', 'SUPPRESSED', 'ABSENT', 'REFUSED'])
    expect(PRESENCE_VERDICTS).toEqual(['agrees', 'pending', 'diverged', 'unknown', 'unreachable'])
    for (const item of [...PRESENCE_INTENTS.map(intentMeta), ...CHANNEL_FACTS.map(factMeta), ...PRESENCE_VERDICTS.map(verdictMeta)]) {
      expect(item.label.length).toBeGreaterThan(0); expect(item.sentence.length).toBeGreaterThan(0)
    }
    expect(intentMeta('LIVE').label).toBe('Listed')
  })
  it('no intent or in-flight input paints an UNKNOWN fact or its verdict green', () => {
    for (const intent of PRESENCE_INTENTS) for (const inFlight of [false, true]) {
      const line = presenceLine({ ...current, intent, inFlight, fact: 'UNKNOWN', observedAt: null })
      expect(line.intent.tone).not.toBe('success')
      expect(line.fact.tone).toBe('neutral'); expect(line.fact.label).toBe('Not checked')
      expect(line.verdict.tone).not.toBe('success')
    }
  })
  it('absence, stale checks, invalid times, and observations older than the intent never agree', () => {
    for (const change of [{ observedAt: null }, { observedAt: 'invalid' }, { now: current.now + 60_001 }, { intentAt: '2026-09-13T12:01:00Z' }, { freshnessMs: -1 }]) {
      expect(presenceVerdict({ ...current, ...change })).toBe('unknown')
    }
    expect(presenceVerdict(current)).toBe('agrees')
    expect(presenceVerdict({ ...current, inFlight: true })).toBe('pending')
    expect(presenceVerdict({ ...current, fact: 'REFUSED' })).toBe('unreachable')
    expect(presenceVerdict({ ...current, fact: 'NOT_SELLING' })).toBe('diverged')
  })
  it('keeps Nexus hold and the channel fact separate and produces the shared sentence', () => {
    const line = presenceLine({ ...current, intent: 'HELD' })
    expect(presenceVerdict({ ...current, intent: 'HELD' })).toBe('unknown')
    expect(line.fact.label).toBe('Selling')
    expect(line.sentence).toContain('Held · Selling. We send nothing; the channel keeps what it has.')
    expect(line.asOf).toBe(at)
  })
  it('unknown wire members stay verbatim and neutral instead of falling back to known data', () => {
    expect(intentMeta('FUTURE' as Presence['intent'])).toEqual({ label: 'FUTURE', tone: 'neutral', sentence: 'Unrecognised presence state “FUTURE”.' })
    expect(presenceVerdict({ ...current, fact: 'FUTURE' as Presence['fact'] })).toBe('unknown')
  })
})

it('prototype property names are unknown wire states, not table members', () => {
  const p = { intent: 'toString', fact: 'constructor', intentAt: null, observedAt: '2026-09-13T12:00:00Z', now: Date.parse('2026-09-13T12:00:01Z'), freshnessMs: 5000, inFlight: false } as unknown as Presence
  expect(presenceVerdict(p)).toBe('unknown')
  expect(intentMeta(p.intent)).toMatchObject({ label: 'toString', tone: 'neutral' })
  expect(factMeta(p.fact)).toMatchObject({ label: 'constructor', tone: 'neutral' })
})

it('a failed attempt stays REFUSED even when its timestamp is absent', () => {
  const line = presenceLine({ ...current, fact: 'REFUSED', observedAt: null })
  expect(line.fact).toEqual(factMeta('REFUSED'))
  expect(line.verdict).toEqual(verdictMeta('unreachable'))
  expect(line.asOf).toBeNull()
})
