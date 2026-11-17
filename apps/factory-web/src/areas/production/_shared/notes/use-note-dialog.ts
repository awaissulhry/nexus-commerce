'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { listPeople } from '../../../../record-panels/api'
import { checkNotes, writeNotes } from './api'
import {
  bodyOf,
  checkOf,
  draftAfter,
  draftKeyOf,
  lastAnswerOf,
  mergePeople,
  NEW_DRAFT,
  peopleSources,
  recordsOf,
  resultOf,
  sendHeld,
  writeProblemOf,
  type CheckState,
  type NoteDialogActions,
  type NoteDialogModel,
  type NoteFrom,
  type NoteTargets,
  type PeopleState,
  type WriteOn,
} from './model'

/** How long the text rests before it is checked (ms). */
const CHECK_AFTER_MS = 400

/**
 * F-PR-22 — the note dialog's container part (one for the band and for Work orders): `open(targets, from)` starts a draft ("Each
 * record's supervisor" ticked, written on each work order), reads who may be mentioned (one people read per customer and company of the
 * records, threads' GET /threads/<type>/<id>/people, crossed into one @ list) and checks the draft a moment after each change (the
 * check route: who cannot read some records, the customers, the other-customer hold). `onSend` writes ONE batch (one Idempotency-Key
 * per draft: a second press after a lost answer is the same command); a 409 "names another customer" reads the check again and keeps
 * Send held. Offline and busy hold Send with words; the text is never lost on a refusal. `onDone` lets the page read its rows again.
 */
export function useNoteDialog(api: ApiClient, options: { readonly can: boolean; readonly onDone?: () => void }) {
  const [state, setState] = useState<Omit<NoteDialogModel, 'check' | 'offline' | 'can'> | null>(null)
  const [check, setCheck] = useState<CheckState>({ status: 'idle' })
  const [offline, setOffline] = useState(false)
  const [checkTurn, setCheckTurn] = useState(0)
  const latest = useRef(state)
  latest.current = state
  const done = useRef(options.onDone)
  done.current = options.onDone
  const peopleTurn = useRef(0)
  const writeKey = useRef<{ key: string; draft: string } | null>(null)

  // Offline holds Send (the text stays in the dialog until the network is back).
  useEffect(() => {
    const down = () => setOffline(true)
    const up = () => setOffline(false)
    if (typeof navigator !== 'undefined' && navigator.onLine === false) down()
    window.addEventListener('offline', down)
    window.addEventListener('online', up)
    return () => {
      window.removeEventListener('offline', down)
      window.removeEventListener('online', up)
    }
  }, [])

  const readPeople = useCallback(
    (targets: NoteTargets, on: WriteOn) => {
      const mine = ++peopleTurn.current
      const { sources, complete } = peopleSources(recordsOf(targets, on))
      setState((current) => (current ? { ...current, people: { status: 'loading' } } : current))
      Promise.allSettled(sources.map((record) => listPeople(api, { type: record.type, id: record.id })))
        .then((answers) => {
          if (mine !== peopleTurn.current) return
          const read = answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value.people] : []))
          const people: PeopleState = read.length === 0 && sources.length > 0 ? { status: 'error' } : { status: 'ready', people: mergePeople(read), complete: complete && read.length === sources.length }
          setState((current) => (current ? { ...current, people } : current))
        })
    },
    [api],
  )

  /** Opens the dialog over these records (the caller holds a selection over 100 with its words). */
  const open = useCallback(
    (targets: NoteTargets, from: NoteFrom) => {
      writeKey.current = null
      setCheck({ status: 'idle' })
      setState({ from, targets, draft: NEW_DRAFT, people: { status: 'loading' }, busy: false, problem: null, result: null })
      readPeople(targets, NEW_DRAFT.on)
    },
    [readPeople],
  )

  // The draft as the API takes it, and its key (a check or a write answers the draft of the same key only).
  const people = state?.people.status === 'ready' ? state.people.people : null
  const body = useMemo(() => (state ? bodyOf(state.targets, state.draft, people ?? []) : null), [state?.targets, state?.draft, people])
  const key = body ? draftKeyOf(body) : ''

  // The check, a moment after the draft rests (none for an empty text, offline, or after Send).
  useEffect(() => {
    if (!body || !state || state.result || body.body.trim() === '' || body.records.length === 0 || offline) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setCheck((current) => ({ status: 'checking', key, previous: lastAnswerOf(current) }))
      checkNotes(api, body, controller.signal)
        .then((answer) => setCheck((current) => (current.status !== 'idle' && current.key === key ? { status: 'ready', key, answer } : current)))
        .catch(() => {
          if (controller.signal.aborted) return
          setCheck((current) => (current.status !== 'idle' && current.key === key ? { status: 'failed', key } : current))
        })
    }, CHECK_AFTER_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `key` stands for the body; a retry bumps `checkTurn`.
  }, [api, key, offline, state?.result, checkTurn])

  const shownCheck = checkOf(check, key)
  const model: NoteDialogModel | null = state ? { ...state, check: shownCheck, offline, can: options.can } : null
  const modelRef = useRef(model)
  modelRef.current = model
  const bodyRef = useRef(body)
  bodyRef.current = body

  const actions = useMemo<NoteDialogActions>(
    () => ({
      onDraft: (next) => {
        const current = latest.current
        if (!current || current.busy || current.result) return
        const draft = draftAfter(current.draft, next)
        setState({ ...current, draft, problem: null })
        if (next.on && next.on !== current.draft.on) readPeople(current.targets, next.on)
      },
      onSend: () => {
        const now = modelRef.current
        const draft = bodyRef.current
        if (!now || !draft || now.result) return
        if (sendHeld({ can: now.can, records: draft.records.length, body: draft.body, offline: now.offline, busy: now.busy, check: now.check })) return
        const draftKey = draftKeyOf(draft)
        if (!writeKey.current || writeKey.current.draft !== draftKey) writeKey.current = { key: newIdempotencyKey(), draft: draftKey }
        setState((current) => (current ? { ...current, busy: true, problem: null } : current))
        const names = new Map((now.people.status === 'ready' ? now.people.people : []).map((person) => [person.id, person.name] as const))
        if (now.check.status === 'ready') for (const person of now.check.answer.people) names.set(person.userId, person.name)
        writeNotes(api, draft, writeKey.current.key)
          .then((answer) => {
            setState((current) => (current ? { ...current, busy: false, result: resultOf(answer, recordsOf(current.targets, current.draft.on), names) } : current))
            done.current?.()
          })
          .catch((error: unknown) => {
            const problem = writeProblemOf(error)
            setState((current) => (current ? { ...current, busy: false, problem: problem.key } : current))
            // The text names another customer after all (a name added, or the hold not seen): read the check again.
            if (problem.recheck) setCheckTurn((turn) => turn + 1)
          })
      },
      onRetryCheck: () => setCheckTurn((turn) => turn + 1),
      onRetryPeople: () => {
        const current = latest.current
        if (current) readPeople(current.targets, current.draft.on)
      },
      onClose: () => {
        peopleTurn.current++
        writeKey.current = null
        setCheck({ status: 'idle' })
        setState(null)
      },
    }),
    [api, readPeople],
  )

  return { model, actions, open }
}
