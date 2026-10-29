'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { parseLiveData } from '../../../record-panels/live'
import type { LiveChange } from '../../../record-panels/model'
import type { LiveState } from './model'

/** The tab a record page shows (`?tab=`): one of its tabs, else the first. */
export function useRecordTab<T extends string>(tabs: readonly T[]): T {
  const params = useSearchParams()
  const asked = params?.get('tab') ?? ''
  return (tabs as readonly string[]).includes(asked) ? (asked as T) : tabs[0]!
}

/**
 * The live stream (`GET /live` through this app's `/api`) with its state in words: connecting, live, offline (the
 * browser's EventSource reconnects by itself; after a break the screen reads everything again). A message is a hint:
 * the screen reads the part again, it never takes data from the message.
 */
export function useLive(onChange: (change: LiveChange) => void, onReconnect: () => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting')
  const handlers = useRef({ onChange, onReconnect })
  handlers.current = { onChange, onReconnect }
  useEffect(() => {
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
  }, [])
  return state
}

/** Whether a live event is one of these types (or starts with one of these prefixes ending in `.` or `_`). */
export function liveMatches(change: LiveChange, types: readonly string[]): boolean {
  return types.some((type) => (type.endsWith('.') || type.endsWith('_') ? change.type.startsWith(type) : change.type === type))
}

/** The person closed the code dialog: the action was not taken. */
export class StepUpCancelled extends Error {
  override name = 'StepUpCancelled'
}

export const isStepUpCancelled = (error: unknown): error is StepUpCancelled => error instanceof StepUpCancelled

/** The step-up dialog's state: open with the sentence of what the code allows, busy while the API checks it. */
export interface StepUpState {
  readonly open: boolean
  readonly busy: boolean
  /** A message key (namespace `quality`) of what the code allows. */
  readonly sentence: string
  /** A message key of the last refusal of a code. */
  readonly problem: string | null
}

export const STEP_UP_CLOSED: StepUpState = Object.freeze({ open: false, busy: false, sentence: '', problem: null })

/**
 * The rule, without React: run `work`; on a 403 that asks for a step-up (`stepUp`), wait until `askForCode` resolves (the
 * person typed a code the API took) and run `work` once more. Any other error, and a closed code dialog, goes up.
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

/** The words of a refused code: wrong or used, too many tries, or no answer. */
export function stepUpProblem(error: unknown): string {
  if (!isApiError(error)) return 'stepUp.problem.unavailable'
  if (error.kind === 'rate_limited') return 'stepUp.problem.locked'
  if (error.kind === 'invalid' || error.kind === 'forbidden' || error.kind === 'signed_out') return 'stepUp.problem.wrong'
  return 'stepUp.problem.unavailable'
}

/**
 * Signing a result, releasing garments and loosening a rule ask for a fresh authenticator code (the API's
 * `requireStepUp`, asked after every other check: a refused release never asks for the code). The action runs as asked;
 * on a 403 `stepUp` the DS step-up dialog opens, the code goes to `POST /auth/office/step-up` (5 minutes on this
 * session), and the action runs once more. Asked at the moment of the action, never at page load.
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

  return { stepUp, guard, submitStepUp: submit, cancelStepUp: cancel }
}

/** The byte-order mark spreadsheet programs need to read a UTF-8 CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff)

/** Downloads text as a file (Export "This view (CSV)"): a Blob link, clicked once. */
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

/** One CSV line: every value quoted when it holds a separator, a quote or a line break. */
export function csvLine(values: readonly (string | number | null | undefined)[]): string {
  return values
    .map((value) => {
      const text = value === null || value === undefined ? '' : String(value)
      return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    })
    .join(',')
}

/** A key the page answers while the focus is on the page (not typing, not in a menu or a dialog). */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.isContentEditable) return false
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')
}
