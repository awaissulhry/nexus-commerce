'use client'

/**
 * Approvals grid — can the fleet workers ask you yet? (PLAN §2: the readout moves from the top of the page into the
 * "How it works" drawer; nothing is deleted). Clean-up F, 2026-10-05: the old page's gate-state section, same facts,
 * design-system parts only.
 *
 * GET /api/agent/fleet/approvals/gate-state composes every sentence on the server (agent-fleet-approvals.routes.ts):
 * the halt, and the three conditions that must all be met before a fleet worker can put a request here, each with
 * who can change it. This file renders them verbatim; it never re-composes one, because two composers over one set of
 * facts drift. The same read carries the expiry hours the drawer prints (`expiry.hours`, the API's EXPIRY_HOURS).
 *
 * Read when the drawer opens, not with the page: it is about ten queries, and only this drawer needs it.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { Banner } from '@/design-system/components'
import { Button, Pill, Skeleton, type Tone } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import styles from './HowItWorks.module.css'

/* ── the wire (a hand-written mirror of agent-fleet-approvals.routes.ts; only the fields read here) ─────────── */

export interface GateCondition {
  key: 'worker-may-ask' | 'action-can-run' | 'something-scheduled'
  met: boolean
  /** The condition itself, composed on the server. Rendered verbatim. */
  requirement: string
  /** Why it is or is not met, with the numbers already inside. Rendered verbatim. */
  detail: string
  /** Who can change it. */
  owner: 'operator' | 'engineering' | 'automatic'
  href: string | null
  /** An instant the condition refers to (the next council), ISO. */
  at: string | null
}

export interface GateTool {
  name: string
  canExecute: boolean
  isFleetTool: boolean
}

export interface GateState {
  halted: boolean
  haltReason: string | null
  canAnythingArrive: boolean
  conditions: GateCondition[]
  tools: GateTool[]
  expiry?: { hours?: number }
}

export type GateRead = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; gate: GateState }

/** Reads the gate state each time `active` turns true (the drawer opens), and on `reload`. */
export function useGateState(active: boolean): { read: GateRead; reload: () => void } {
  const [read, setRead] = useState<GateRead>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setRead((now) => (now.kind === 'ready' ? now : { kind: 'loading' }))
    fetch(`${getBackendUrl()}/api/agent/fleet/approvals/gate-state`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Nexus answered ${response.status}.`)
        const gate = (await response.json()) as GateState
        setRead({ kind: 'ready', gate })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setRead({ kind: 'error', message: error instanceof Error ? error.message : 'Nexus could not be reached.' })
      })
    return () => controller.abort()
  }, [active, attempt])
  return { read, reload }
}

/** The expiry the API states, in hours; null until it was read. */
export function expiryHoursOf(read: GateRead): number | null {
  const hours = read.kind === 'ready' ? read.gate.expiry?.hours : undefined
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : null
}

/* ── words ──────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The fleet's three actions, in plain words. They were the `shortAsk` of the Fleet overview's decision card
 * (DecisionCard.tsx), deleted with that page's inbox on 2026-10-05; this drawer was its last reader. A name the list
 * does not know is shown as its own words.
 */
const FLEET_TOOL_ASK: Record<string, string> = {
  'create-negative-keyword': 'stop ads showing for a search term',
  'graduate-keyword': 'promote a search term to its own keyword',
  'set-target-bid': "change a keyword's bid",
}

export function fleetToolAsk(toolName: string): string {
  return FLEET_TOOL_ASK[toolName] ?? toolName.replace(/[_-]+/g, ' ').trim()
}

export const OWNER_LINE: Record<GateCondition['owner'], string> = {
  operator: 'Yours to change',
  engineering: 'Ours to build — nothing you can do here',
  automatic: 'Automatic',
}

/** A condition's state as a word, never as colour only. "Not yet" and "Not built" are states, not faults. */
export function conditionState(condition: Pick<GateCondition, 'met' | 'owner'>): { label: string; tone: Tone } {
  if (condition.met) return { label: 'Ready', tone: 'success' }
  if (condition.owner === 'engineering') return { label: 'Not built', tone: 'neutral' }
  if (condition.owner === 'automatic') return { label: 'Not set up', tone: 'neutral' }
  return { label: 'Not yet', tone: 'neutral' }
}

/** "in 3h", "in 12 min", "in 4 days", "due now". */
export function whenNext(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return 'at a time Nexus could not read'
  if (ms <= 0) return 'due now'
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)} days`
}

/** The section's heading: the answer, never the question. */
export function gateHeadline(gate: Pick<GateState, 'halted' | 'canAnythingArrive'>): string {
  if (gate.halted) return 'The fleet is halted: no fleet worker can ask you'
  return gate.canAnythingArrive ? 'Fleet workers can ask you' : 'Fleet workers cannot ask you yet'
}

/** "2 of 3 conditions are met." */
export function conditionsMetText(conditions: readonly Pick<GateCondition, 'met'>[]): string {
  const met = conditions.filter((c) => c.met).length
  return `${met} of ${conditions.length} ${conditions.length === 1 ? 'condition is' : 'conditions are'} met.`
}

const sentenceCase = (text: string) => text.replace(/^./, (c) => c.toUpperCase())

/* ── the readout ────────────────────────────────────────────────────────────────────────────────────────────── */

export function FleetGateState({ read, onRetry, now = Date.now() }: { read: GateRead; onRetry: () => void; now?: number }) {
  if (read.kind === 'loading') {
    return (
      <section className={styles.section} aria-busy="true" aria-label="Reading whether fleet workers can ask you">
        <Skeleton height={14} width="60%" />
        <Skeleton height={48} />
      </section>
    )
  }
  if (read.kind === 'error') {
    // Never silence: a failed read must not look like "nothing can arrive" or "everything is ready".
    return (
      <section className={styles.section}>
        <h3 className={styles.heading}>Whether fleet workers can ask you is not known right now</h3>
        <Banner tone="warning" title="The fleet’s state could not be read." action={<Button size="sm" onClick={onRetry}>Try again</Button>}>
          {read.message}
        </Banner>
      </section>
    )
  }

  const { gate } = read
  const conditions = gate.conditions ?? []
  const fleetTools = (gate.tools ?? []).filter((tool) => tool.isFleetTool)
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{gateHeadline(gate)}</h3>
      {gate.halted && (
        <Banner tone="danger" title="The whole fleet is halted.">
          {gate.haltReason ?? 'No reason was recorded.'} No fleet worker runs until it is released on{' '}
          <Link href="/fleet/controls" className={styles.link}>Controls</Link>.
        </Banner>
      )}
      <p className={styles.text}>
        A fleet worker can put a request here only when all of these are true (Claude’s requests do not need them).{' '}
        {conditionsMetText(conditions)}
      </p>
      <ol className={styles.conditions} aria-label="What must be true before a fleet worker can ask you">
        {conditions.map((condition) => {
          const state = conditionState(condition)
          const tools = condition.key === 'action-can-run' ? fleetTools : []
          return (
            <li key={condition.key} className={styles.condition}>
              <span className={styles.conditionState}><Pill tone={state.tone} size="sm">{state.label}</Pill></span>
              <span className={styles.conditionBody}>
                <span className={styles.requirement}>{condition.requirement}</span>
                <span className={styles.muted}>
                  {OWNER_LINE[condition.owner]}
                  {condition.href ? <> · <Link href={condition.href} className={styles.link}>Controls</Link></> : null}
                </span>
                <span className={styles.text}>
                  {condition.detail}
                  {condition.at ? <> Next <time dateTime={condition.at}>{whenNext(condition.at, now)}</time>.</> : null}
                </span>
                {tools.length > 0 && (
                  <ul className={styles.tools} aria-label="The fleet’s actions">
                    {tools.map((tool) => (
                      <li key={tool.name} className={styles.tool}>
                        <Pill tone={tool.canExecute ? 'success' : 'neutral'} size="sm">{tool.canExecute ? 'Can run' : 'Describes only'}</Pill>
                        <span className={styles.text}>{sentenceCase(fleetToolAsk(tool.name))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
