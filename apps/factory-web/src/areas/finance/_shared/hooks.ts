'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { parseLiveData } from '../../../record-panels/live'
import type { LiveChange } from '../../../record-panels/model'

export type LiveState = 'connecting' | 'live' | 'offline'

/**
 * The live stream (`GET /live` through this app's `/api`): the events this person may see, with the stream's state in
 * words (connecting, live, offline; the browser's EventSource reconnects by itself, and after a break the page reads
 * everything again). A message is a hint: the page reads the part again.
 */
export function useLive(onChange: (change: LiveChange) => void, onReconnect: () => void, enabled = true): LiveState {
  const [state, setState] = useState<LiveState>('connecting')
  const handlers = useRef({ onChange, onReconnect })
  handlers.current = { onChange, onReconnect }
  useEffect(() => {
    if (!enabled) return
    if (typeof EventSource === 'undefined') {
      setState('offline')
      return
    }
    const source = new EventSource('/api/live')
    let readyOnce = false
    const onReady = () => {
      setState('live')
      if (readyOnce) handlers.current.onReconnect()
      readyOnce = true
    }
    const onMessage = (event: MessageEvent<string>) => {
      const change = parseLiveData(event.data)
      if (change) handlers.current.onChange(change)
    }
    const onError = () => setState(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting')
    source.addEventListener('ready', onReady)
    source.addEventListener('change', onMessage as EventListener)
    source.addEventListener('error', onError)
    return () => {
      source.removeEventListener('ready', onReady)
      source.removeEventListener('change', onMessage as EventListener)
      source.removeEventListener('error', onError)
      source.close()
    }
  }, [enabled])
  return state
}

/** Calls `run` at most once per `ms` while changes keep coming (a burst of floor scans: one read). */
export function useCoalesced(run: () => void, ms = 600): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(run)
  latest.current = run
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      latest.current()
    }, ms)
  }, [ms])
}

const WIDE = '(min-width: 1280px)'

/**
 * Owner O1: the record's thread beside any tab on a wide screen (1280 px and wider, ⌘J), remembered on this device per
 * record type (a per-viewer convenience: localStorage, read and written with try/catch); narrower, the same button
 * opens Activity.
 */
export function useThreadDock(recordType: string) {
  const DOCK_KEY = `fw.finance.dock.${recordType}`
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setOpen(false)
    }
  }, [DOCK_KEY])
  const toggle = useCallback(() => {
    let wide = false
    try {
      wide = window.matchMedia(WIDE).matches
    } catch {
      wide = false
    }
    if (!wide) {
      router.push(`${pathname}?tab=activity`)
      return
    }
    setOpen((current) => {
      const next = !current
      try {
        window.localStorage.setItem(DOCK_KEY, next ? '1' : '0')
      } catch {
        // Not kept on this device; the dock still toggles.
      }
      return next
    })
  }, [pathname, router, DOCK_KEY])
  return { dockOpen: open, toggleDock: toggle }
}

/** The byte-order mark spreadsheet programs need to read a UTF-8 CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff)

/** Downloads text as a file (Export N (CSV)): a Blob link, clicked once. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([`${BOM}${text}`], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- step-up (A1 §3.10: issuing an invoice, sending it to SDI, correcting a rejected one, the bank account) ----------------------

/** The person closed the code dialog: the action was not taken. */
export class StepUpCancelled extends Error {
  override name = 'StepUpCancelled'
}

export const isStepUpCancelled = (error: unknown): error is StepUpCancelled => error instanceof StepUpCancelled

export interface StepUpState {
  readonly open: boolean
  readonly busy: boolean
  /** A message key (`finance`) of what the code allows. */
  readonly sentence: string
  /** A message key of the last refusal of a code. */
  readonly problem: string | null
}

export const STEP_UP_CLOSED: StepUpState = Object.freeze({ open: false, busy: false, sentence: '', problem: null })

/**
 * Run `work`; on a 403 that asks for a step-up (`stepUp`), wait until `askForCode` resolves (the person typed a code the
 * API took) and run `work` once more with the SAME idempotency key (the caller keeps it). Any other error, and a closed
 * code dialog, goes up.
 */
export async function runWithStepUp<T>(work: () => Promise<T>, askForCode: () => Promise<void>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!isApiError(error) || error.kind !== 'step_up') throw error
    await askForCode()
    return work()
  }
}

export function stepUpProblem(error: unknown): string {
  if (!isApiError(error)) return 'stepUp.problem.unavailable'
  if (error.kind === 'rate_limited') return 'stepUp.problem.locked'
  if (error.kind === 'invalid' || error.kind === 'forbidden' || error.kind === 'signed_out') return 'stepUp.problem.wrong'
  return 'stepUp.problem.unavailable'
}

/**
 * Issuing an invoice, sending it to SDI, correcting a rejected one, a deposit's TD02 and the bank account ask for a fresh
 * authenticator code (the API's `requireStepUp`, asked after every other check). Before such a write the code is asked
 * first when the session has none fresh (`ensureFresh`), so the write is sent once; on a late 403 `stepUp` the DS step-up
 * dialog opens, the code goes to `POST /auth/office/step-up` (minutes on this session), and the write runs once more with
 * the same idempotency key. Never asked at page load.
 */
export function useStepUp(api: ApiClient) {
  const [stepUp, setStepUp] = useState<StepUpState>(STEP_UP_CLOSED)
  const waiting = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null)

  const guard = useCallback(
    <T,>(sentence: string, work: () => Promise<T>): Promise<T> =>
      runWithStepUp(
        work,
        () =>
          new Promise<void>((resolve, reject) => {
            waiting.current = { resolve, reject }
            setStepUp({ open: true, busy: false, sentence, problem: null })
          }),
      ),
    [],
  )

  /**
   * Before a write that will ask a step-up: when this session has no fresh one (`GET /auth/office/me` session.stepUpUntil),
   * the code is asked first, so the write is sent once (no refused try on the way). A step-up that ends meanwhile is
   * still caught by `guard`.
   */
  const ensureFresh = useCallback(
    async (sentence: string): Promise<void> => {
      let fresh = false
      try {
        const me = await api.get('/auth/office/me', { schema: z.object({ session: z.object({ stepUpUntil: z.string().nullable().optional() }) }) })
        fresh = !!me.session.stepUpUntil && Date.parse(me.session.stepUpUntil) > Date.now() + 20_000
      } catch {
        fresh = false
      }
      if (fresh) return
      await new Promise<void>((resolve, reject) => {
        waiting.current = { resolve, reject }
        setStepUp({ open: true, busy: false, sentence, problem: null })
      })
    },
    [api],
  )

  const submit = useCallback(
    async (code: string) => {
      setStepUp((current) => ({ ...current, busy: true, problem: null }))
      try {
        await api.post('/auth/office/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })
        setStepUp(STEP_UP_CLOSED)
        waiting.current?.resolve()
        waiting.current = null
      } catch (error) {
        setStepUp((current) => ({ ...current, busy: false, problem: stepUpProblem(error) }))
      }
    },
    [api],
  )

  const cancel = useCallback(() => {
    setStepUp(STEP_UP_CLOSED)
    waiting.current?.reject(new StepUpCancelled())
    waiting.current = null
  }, [])

  return { stepUp, guard, ensureFresh, submitStepUp: submit, cancelStepUp: cancel }
}
