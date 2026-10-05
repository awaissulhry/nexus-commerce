/**
 * Approvals grid — "How it works" and the fleet's readiness readout (clean-up F, 2026-10-05). Rendered HTML (node SSR,
 * the drawer's content without the drawer) and the source text.
 *
 * Pins: every status the API can send is explained in the grid's own words; the expiry comes from the API, never a
 * typed number; headings are answers; the old fleet-era words are gone; the readout shows the server's facts verbatim
 * (halt, conditions, who can change each, the fleet's actions) and says so when it could not read them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { QUEUE_STATES } from '@nexus/shared/approval-queue'
import type { GridShortcutHint } from '@/design-system/grid'

vi.mock('@/lib/workspaces/Link', () => ({
  default: ({ href, children, className }: { href: string; children?: ReactNode; className?: string }) => createElement('a', { href, className }, children),
}))

const { HowItWorksContent, LIFE_ORDER, stateHelp } = await import('./HowItWorks')
const { FleetGateState, conditionState, conditionsMetText, expiryHoursOf, gateHeadline, whenNext } = await import('./FleetGateState')
const { STATE_META } = await import('./queueWords')
type GateRead = import('./FleetGateState').GateRead
type GateState = import('./FleetGateState').GateState

const NOW = Date.parse('2026-10-05T10:00:00.000Z')

const gate = (over: Partial<GateState> = {}): GateState => ({
  halted: false,
  haltReason: null,
  canAnythingArrive: false,
  conditions: [
    { key: 'worker-may-ask', met: false, requirement: 'A worker has to be allowed to ask', detail: 'None of your 7 workers is set to PROPOSE.', owner: 'operator', href: '/fleet/controls', at: null },
    { key: 'action-can-run', met: true, requirement: 'What it proposes has to be able to run', detail: "3 of the fleet's 3 actions can actually run.", owner: 'engineering', href: null, at: null },
    { key: 'something-scheduled', met: false, requirement: 'Something has to be scheduled to ask', detail: 'The weekly council is not scheduled.', owner: 'automatic', href: null, at: '2026-10-05T13:00:00.000Z' },
  ],
  tools: [
    { name: 'set-target-bid', canExecute: true, isFleetTool: true },
    { name: 'create-negative-keyword', canExecute: false, isFleetTool: true },
    { name: 'set-price', canExecute: true, isFleetTool: false },
  ],
  expiry: { hours: 24 },
  ...over,
})

const KEYS: GridShortcutHint[] = [
  { key: 'a', keyLabel: 'A', label: 'Approve', disabled: false },
  { key: 'r', keyLabel: 'R', label: 'Reject', disabled: false },
  { key: 'Enter', keyLabel: 'Enter', label: 'Details', disabled: false },
  { key: 'Escape', keyLabel: 'Esc', label: 'Close details', disabled: false },
  { key: 'Space', keyLabel: 'Space', label: 'Tick', disabled: false },
]

const content = (read: GateRead) =>
  renderToStaticMarkup(createElement(HowItWorksContent, { keys: KEYS, gate: read, onRetryGate: () => undefined, now: NOW }))
const readout = (read: GateRead) => renderToStaticMarkup(createElement(FleetGateState, { read, onRetry: () => undefined, now: NOW }))
/** The visible words: tags out, entities decoded, one space, none before punctuation. */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([.,;:)])/g, '$1')
const headings = (html: string) => [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1]).trim())

describe('How it works — this page, in plain words', () => {
  it('explains every status the API can send, in the grid’s own words and tones', () => {
    expect([...LIFE_ORDER].sort()).toEqual([...QUEUE_STATES].sort())
    const html = content({ kind: 'ready', gate: gate() })
    for (const state of QUEUE_STATES) {
      expect(html, state).toContain(`nds-pill ${STATE_META[state].tone}`)
      expect(text(html), state).toContain(STATE_META[state].label)
      expect(stateHelp(state, 24).length, state).toBeGreaterThan(10)
    }
  })

  it('the expiry is the API’s number, never a typed one; until it is read the text does not guess', () => {
    expect(text(content({ kind: 'ready', gate: gate() }))).toContain('Requests expire after 24 hours')
    const other = text(content({ kind: 'ready', gate: gate({ expiry: { hours: 36 } }) }))
    expect(other).toContain('Requests expire after 36 hours')
    expect(other).toContain('Nobody decided within 36 hours.')
    const unknown = text(content({ kind: 'loading' }))
    expect(unknown).toContain('Requests expire when nobody decides in time')
    expect(unknown).not.toMatch(/\b24 hours\b/)
    expect(expiryHoursOf({ kind: 'error', message: 'x' })).toBeNull()
    expect(expiryHoursOf({ kind: 'ready', gate: gate({ expiry: undefined }) })).toBeNull()
    // The source never types the expiry.
    expect(readFileSync(join(import.meta.dirname, 'HowItWorks.tsx'), 'utf8')).not.toMatch(/\b24\b/)
  })

  it('says what Approve, Reject, bulk approve and Automate do', () => {
    const words = text(content({ kind: 'ready', gate: gate() }))
    expect(words).toContain('Approve waits 20 seconds, then runs')
    expect(words).toContain('Undo takes the approve back')
    expect(words).toContain('A reason is optional; it goes back to whoever asked, so Claude sees why you said no.')
    expect(words).toContain('Never in bulk: refunds, messages, cancellations, closing a listing, deleting, change plans, or any kind that cannot be undone.')
    expect(words).toContain('“Ask me”, “Confirm in Claude with my code” or “Run by themselves within these limits”')
    expect(words).toContain('going back to “Ask me” needs no code')
    expect(words).toContain('A rule changes only new requests')
  })

  it('lists the keys the page binds', () => {
    const html = content({ kind: 'ready', gate: gate() })
    for (const key of KEYS) {
      expect(html).toContain(`>${key.keyLabel}</kbd>`)
      expect(text(html)).toContain(key.label)
    }
    expect(text(html)).toContain('Approve (Retry on a failed request)')
  })

  it('headings are answers, not questions; no fleet-era words', () => {
    const html = content({ kind: 'ready', gate: gate() })
    const all = headings(html)
    expect(all.length).toBeGreaterThanOrEqual(9)
    for (const heading of all) expect(heading, heading).not.toMatch(/\?\s*$/)
    for (const name of ['HowItWorks.tsx', 'FleetGateState.tsx']) {
      const source = readFileSync(join(import.meta.dirname, name), 'utf8')
      expect(source, name).not.toMatch(/eighteen|setup script|outside the fleet|from before the fleet/i)
    }
    expect(text(html)).not.toMatch(/eighteen|setup script|outside the fleet|critic/i)
  })
})

describe('the fleet’s readiness, in the drawer', () => {
  it('each condition as the server wrote it, with its state as a word and who can change it', () => {
    const html = readout({ kind: 'ready', gate: gate() })
    const words = text(html)
    expect(headings(html)).toEqual(['Fleet workers cannot ask you yet'])
    expect(words).toContain('1 of 3 conditions are met.')
    expect(words).toContain('A worker has to be allowed to ask')
    expect(words).toContain('None of your 7 workers is set to PROPOSE.')
    expect(words).toContain('Yours to change · Controls')
    expect(html).toContain('href="/fleet/controls"')
    expect(words).toContain('Ours to build — nothing you can do here')
    expect(words).toContain('Next in 3h.')
    for (const label of ['Ready', 'Not yet', 'Not set up']) expect(words).toContain(label)
  })

  it('the fleet’s own actions, and whether each can run; Claude’s kinds are not listed', () => {
    const words = text(readout({ kind: 'ready', gate: gate() }))
    expect(words).toContain("Can run Change a keyword's bid")
    expect(words).toContain('Describes only Stop ads showing for a search term')
    expect(words).not.toMatch(/set price/i)
  })

  it('a halt is the one fault: a danger banner with the reason, above the conditions', () => {
    const html = readout({ kind: 'ready', gate: gate({ halted: true, haltReason: 'Paused for the stock count.' }) })
    expect(html).toMatch(/nds-banner danger/)
    expect(text(html)).toContain('The whole fleet is halted. Paused for the stock count. No fleet worker runs until it is released on Controls')
    expect(headings(html)).toEqual(['The fleet is halted: no fleet worker can ask you'])
    expect(text(readout({ kind: 'ready', gate: gate({ halted: true }) }))).toContain('No reason was recorded.')
  })

  it('a failed read says so and offers Try again; loading reserves its space', () => {
    const failed = readout({ kind: 'error', message: 'Nexus answered 500.' })
    expect(failed).toMatch(/nds-banner warning/)
    expect(text(failed)).toContain('The fleet’s state could not be read. Nexus answered 500.')
    expect(text(failed)).toContain('Try again')
    expect(readout({ kind: 'loading' })).toContain('aria-busy="true"')
  })

  it('the words, one by one', () => {
    expect(gateHeadline({ halted: false, canAnythingArrive: true })).toBe('Fleet workers can ask you')
    expect(conditionState({ met: true, owner: 'operator' })).toEqual({ label: 'Ready', tone: 'success' })
    expect(conditionState({ met: false, owner: 'engineering' }).label).toBe('Not built')
    expect(conditionsMetText([{ met: true }])).toBe('1 of 1 condition is met.')
    expect(whenNext('2026-10-05T10:20:00.000Z', NOW)).toBe('in 20 min')
    expect(whenNext('2026-10-08T10:00:00.000Z', NOW)).toBe('in 3 days')
    expect(whenNext('2026-10-05T09:00:00.000Z', NOW)).toBe('due now')
  })
})

describe('built on the design system only', () => {
  const HERE = import.meta.dirname
  const source = (name: string) => readFileSync(join(HERE, name), 'utf8')

  it('no raw control, no Tailwind, no legacy kit; the drawer carries the fleet light pin', () => {
    for (const name of ['HowItWorks.tsx', 'FleetGateState.tsx']) {
      const code = source(name)
      expect(code, name).not.toMatch(/<(button|input|select|table|textarea)[\s>]/)
      expect(code, name).not.toMatch(/components\/ui/)
      // Module classes only; the one literal is the fleet light pin on the drawer.
      for (const [, classes] of code.matchAll(/className="([^"]*)"/g)) expect(classes, name).toBe('fleet-portal')
    }
    expect(source('HowItWorks.tsx')).toMatch(/<Drawer\b[\s\S]*?className="fleet-portal"/)
  })

  it('the stylesheet holds layout only, on the design tokens', () => {
    const css = source('HowItWorks.module.css')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/font-size:\s*\d/)
    expect(css).not.toMatch(/var\(--(?!nds-)/)
  })
})
