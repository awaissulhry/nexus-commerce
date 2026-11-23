'use client'

import { useCallback, useRef, useState } from 'react'
import { manyHeld, newBatchId, planOf, receiptOf, type ManyAct, type ManyRecord, type ManyReceipt, type ManyResult, type ManyText, type ManyWords, type RecordField, type RunAnswer } from './model'

/**
 * F-CQ-201 (customer page › Quotes & incoming, 13-backend §11): the container of the ONE many-acts window — which act on which ticked
 * records, the text and each record's own field as typed, then the run one record after the other (each with its own version, ONE
 * `batchId` for the whole run: one bell per batch, S2), the receipt, "Run the rest again" (a new batch over the ones not done). The
 * list reads again when a run ends. Nothing runs before the click; closing before it changes nothing.
 */

export interface ManyActModel {
  readonly title: ManyWords
  readonly go: ManyWords
  readonly body: ManyWords | null
  readonly danger: boolean
  readonly plan: {
    readonly runs: ReadonlyArray<{ readonly id: string; readonly label: string; readonly field: RecordField | null }>
    readonly notOn: ReadonlyArray<{ readonly id: string; readonly label: string; readonly why: ManyWords }>
  }
  readonly text: ManyText | null
  readonly typed: string
  readonly fields: Readonly<Record<string, string>>
  /** Why the run waits (nothing to run on, a text or a field missing), or null. */
  readonly held: ManyWords | null
  readonly phase: 'plan' | 'running' | 'receipt'
  readonly progress: { readonly done: number; readonly count: number }
  readonly results: readonly ManyResult[]
  readonly receipt: ManyReceipt | null
}

export interface ManyActActions {
  onText?: (text: string) => void
  onField?: (recordId: string, value: string) => void
  onRun?: () => void
  onRunRest?: () => void
  onClose?: () => void
  /** A record named in the receipt: its thread docks (the host's dock), else its page opens. */
  onName?: (recordId: string) => void
}

export interface ManyState<R extends ManyRecord> {
  readonly act: ManyAct<R>
  readonly records: readonly R[]
  readonly typed: string
  readonly fields: Readonly<Record<string, string>>
  readonly phase: 'plan' | 'running' | 'receipt'
  readonly progress: { readonly done: number; readonly count: number }
  readonly results: readonly ManyResult[]
  readonly token: number
}

/** What the window shows at a step (pure: the hook's state, or a design case's — the same plan, holds and receipt). */
export function manyActModelOf<R extends ManyRecord>(state: Pick<ManyState<R>, 'act' | 'records' | 'typed' | 'fields' | 'phase' | 'progress' | 'results'>): ManyActModel {
  const plan = planOf(state.records, state.act)
  const text = state.act.text?.(plan.runs) ?? null
  return {
    title: state.act.title,
    go: state.act.go,
    body: state.act.body ?? null,
    danger: !!state.act.danger,
    plan: {
      runs: plan.runs.map((record) => ({ id: record.id, label: record.label, field: state.act.field?.(record) ?? null })),
      notOn: plan.notOn.map(({ record, why }) => ({ id: record.id, label: record.label, why })),
    },
    text,
    typed: state.typed,
    fields: state.fields,
    held: state.phase === 'plan' ? manyHeld(plan, text, state.typed, state.fields, state.act.field) : null,
    phase: state.phase,
    progress: state.progress,
    results: state.results,
    receipt: state.phase === 'receipt' ? receiptOf(state.results) : null,
  }
}

export function useManyAct<R extends ManyRecord>(options: { readonly onDone?: () => void; readonly onName?: (recordId: string) => void; /** The record as the list reads it now (Run the rest again acts on fresh versions). */ readonly rowOf?: (recordId: string) => R | undefined } = {}): { model: ManyActModel | null; open: (act: ManyAct<R>, records: readonly R[]) => void; actions: ManyActActions } {
  const [state, setState] = useState<ManyState<R> | null>(null)
  const latest = useRef(state)
  latest.current = state
  const told = useRef(options)
  told.current = options

  const open = useCallback((act: ManyAct<R>, records: readonly R[]) => {
    const token = Date.now()
    setState({ act, records, typed: '', fields: {}, phase: 'plan', progress: { done: 0, count: 0 }, results: [], token })
    const start = act.start?.(planOf(records, act).runs)
    if (start)
      void start
        .then((words) => words && setState((now) => (now && now.token === token && now.typed === '' ? { ...now, typed: words } : now)))
        .catch(() => undefined)
  }, [])

  const run = useCallback(async (only: readonly string[] | null) => {
    const now = latest.current
    if (!now || now.phase === 'running') return
    const plan = planOf(now.records, now.act)
    if (!only && manyHeld(plan, now.act.text?.(plan.runs) ?? null, now.typed, now.fields, now.act.field)) return
    // Run the rest again: each record as the list reads it now (its new version), still one it runs on.
    const runs = only ? only.map((id) => told.current.rowOf?.(id) ?? plan.runs.find((record) => record.id === id)).filter((record): record is R => !!record && now.act.notOn(record) === null) : plan.runs
    const kept = only ? now.results.filter((result) => !only.includes(result.id)) : []
    const batchId = newBatchId()
    setState({ ...now, phase: 'running', progress: { done: 0, count: runs.length }, results: kept })
    const results: ManyResult[] = [...kept]
    for (const [index, record] of runs.entries()) {
      let answer: RunAnswer
      try {
        answer = await now.act.run(record, { text: now.typed, field: now.fields[record.id] ?? '', batchId })
      } catch {
        answer = { done: false, why: { ns: 'before-order', key: 'acts.why.failed' } }
      }
      results.push({ id: record.id, label: record.label, href: record.href, done: answer.done, words: answer.done ? answer.words : answer.why })
      setState((current) => (current && current.token === now.token ? { ...current, progress: { done: index + 1, count: runs.length } } : current))
    }
    setState((current) => (current && current.token === now.token ? { ...current, phase: 'receipt', results } : current))
    told.current.onDone?.()
  }, [])

  const model: ManyActModel | null = state ? manyActModelOf(state) : null

  const actions: ManyActActions = {
    onText: (text) => setState((now) => (now && now.phase === 'plan' ? { ...now, typed: text } : now)),
    onField: (recordId, value) => setState((now) => (now && now.phase === 'plan' ? { ...now, fields: { ...now.fields, [recordId]: value } } : now)),
    onRun: () => void run(null),
    onRunRest: () => {
      const rest = latest.current ? receiptOf(latest.current.results).rest : []
      if (rest.length > 0) void run(rest)
    },
    onClose: () => setState((now) => (now?.phase === 'running' ? now : null)),
    ...(options.onName ? { onName: (recordId: string) => told.current.onName?.(recordId) } : {}),
  }
  return { model, open, actions }
}
