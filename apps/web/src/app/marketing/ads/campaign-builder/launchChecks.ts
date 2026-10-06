/**
 * W2-B — what every campaign builder needs to launch safely (CC-13, CC-14, CC-21, CC-24).
 *
 * Checks: the launch route answers `checks` for a `dryRun: true` body (AI Goal: its preview) — `refusals` (Amazon would
 * refuse it, or it cannot work: no products, a name Amazon refuses or the market already uses, a bid or budget outside
 * Amazon's range) and `warnings` (his bid policies and spend ceilings, Nexus's per-write cap: never a block). The
 * review step shows both; Launch stays off while there is a refusal. The API runs the same checks again at launch.
 *
 * Launch: one Idempotency-Key per launch press (`sendCommand`, lib/command-key.ts). If the answer is lost — the edge
 * proxy closed a long launch, the network dropped — the key is kept, and pressing Launch again waits for that run or
 * replays its result instead of building the campaigns a second time.
 */
import { useEffect, useRef, useState } from 'react'
import { commandConflictMessage, keepsKey, sendCommand, type CommandKey } from '@/lib/command-key'

export interface LaunchChecks {
  /** Amazon would refuse the launch, or it could not work: Launch stays off. */
  refusals: string[]
  /** His own settings: shown, never a block. */
  warnings: string[]
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])

/** The `checks` of a dry-run or preview answer; null when it carried none. Pure. */
export function readChecks(body: unknown): LaunchChecks | null {
  const c = (body as { checks?: unknown } | null)?.checks as { refusals?: unknown; warnings?: unknown } | undefined
  if (!c || typeof c !== 'object') return null
  return { refusals: strings(c.refusals), warnings: strings(c.warnings) }
}

/** Whether Launch must stay off. Pure. */
export function launchBlocked(checks: LaunchChecks | null): boolean {
  return !!checks && checks.refusals.length > 0
}

/**
 * Ask the launch route for its checks whenever the payload changes (debounced). `payload` null = nothing to ask yet.
 * Answers the last checks the server gave for the current payload; null while none has arrived.
 */
export function useLaunchChecks(url: string | null, payload: unknown, delayMs = 500): { checks: LaunchChecks | null; checking: boolean } {
  const [checks, setChecks] = useState<LaunchChecks | null>(null)
  const [checking, setChecking] = useState(false)
  const key = url && payload != null ? JSON.stringify(payload) : null
  const latest = useRef(0)
  useEffect(() => {
    setChecks(null)
    if (!url || key == null) { setChecking(false); return }
    const run = ++latest.current
    setChecking(true)
    const t = setTimeout(() => {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(JSON.parse(key) as object), dryRun: true }) })
        .then((r) => r.json().catch(() => null))
        .then((j) => { if (run === latest.current) setChecks(readChecks(j)) })
        .catch(() => { if (run === latest.current) setChecks(null) })
        .finally(() => { if (run === latest.current) setChecking(false) })
    }, delayMs)
    return () => clearTimeout(t)
  }, [url, key, delayMs])
  return { checks, checking }
}

export type LaunchOutcome<T> = { ok: true; body: T } | { ok: false; error: string }

/** What to say when the launch's answer did not arrive: the run may still be going, and a retry is safe. */
export const LAUNCH_UNANSWERED = 'No answer from the server, so the launch may still be running. Press Launch again in a moment: it waits for that run instead of creating the campaigns twice.'

/** The answer to one launch press, in words. Pure (the builders' tests drive it). */
export function launchOutcome<T>(status: number, body: unknown, conflict: 'running' | 'reused' | null): LaunchOutcome<T> {
  if (conflict) return { ok: false, error: commandConflictMessage(conflict, 'launch') }
  const b = (body ?? {}) as { ok?: unknown; error?: unknown; launch?: unknown }
  if (status >= 200 && status < 300 && b.ok !== false) return { ok: true, body: body as T }
  // W2-A — a launch that ran answers `launch` (each campaign: live / partly made / not made, and why), also when its
  // `ok` is false: that is the result the receipt shows, not an error.
  if (b.launch && typeof b.launch === 'object') return { ok: true, body: body as T }
  if (keepsKey(status, body)) return { ok: false, error: LAUNCH_UNANSWERED }
  return { ok: false, error: typeof b.error === 'string' && b.error.trim() ? b.error : `Launch failed (the server answered ${status}).` }
}

/** POST one launch with its press's key. Never throws: no answer keeps the key and says a retry is safe. */
export async function sendLaunch<T = Record<string, unknown>>(slot: CommandKey, url: string, payload: unknown): Promise<LaunchOutcome<T>> {
  try {
    const { response, body, conflict } = await sendCommand(slot, url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    return launchOutcome<T>(response.status, body, conflict)
  } catch {
    return { ok: false, error: LAUNCH_UNANSWERED }
  }
}
