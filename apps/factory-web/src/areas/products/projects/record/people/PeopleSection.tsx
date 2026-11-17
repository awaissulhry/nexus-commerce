'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { setMyFollow } from '../../../../../record-panels/tasks/api'
import { addPerson, peopleChoices, readPeople, removePerson, type ProjectPeople, type ProjectView } from '../../api'
import { readProblem, writeProblem, type Notice } from '../../model'
import { addedNotice, choicesFor, peopleBlockOf, type AddDialogModel, type ConfirmModel, type PersonRow } from './model'
import { PeopleBlock } from './view/PeopleBlock'

/**
 * B-TH-250 — the project page's People section, the container (threads plan TH-5; the API's B-TH-068): it starts from the people the
 * page read (`GET /projects/:id`) and follows the page when it reads them again, reads the add dialog's choices (`GET …/people/
 * choices?q=`, debounced), adds a colleague or one of the outside company's portal people (`POST …/people`), takes a person out
 * (`DELETE …/people/:userId`, the lead or projects.manage), and leaves (`PUT /threads/Project/<id>/followers/me`, anyone but the
 * lead: the API's own way out). After each write the page gets the API's people (`onChanged`). One Idempotency-Key per attempt (kept
 * only to retry an answer that was lost); held while offline or busy; a refusal said from its code.
 */
export interface PeopleSectionProps {
  readonly project: ProjectView
  readonly people: ProjectPeople
  readonly offline: boolean
  readonly onChanged: (people: ProjectPeople) => void
}

/** A write's key, kept for the same target only while its answer may have been lost (the network), else a new one next time. */
interface Attempt {
  readonly target: string
  readonly key: string
}

const lost = (error: unknown): boolean => !isApiError(error) || error.kind === 'unavailable'

export function PeopleSection({ project, people: given, offline, onChanged }: PeopleSectionProps) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const meId = session.user.id
  const [people, setPeople] = useState<ProjectPeople>(given)
  // The page read its people again (a live change, a reload): those are the truth now.
  useEffect(() => setPeople(given), [given])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<Omit<AddDialogModel, 'offline'> | null>(null)
  const [confirm, setConfirm] = useState<ConfirmModel | null>(null)
  const attempt = useRef<Attempt | null>(null)
  const told = useRef(onChanged)
  told.current = onChanged
  const keyFor = (target: string): string => {
    if (attempt.current?.target !== target) attempt.current = { target, key: newIdempotencyKey() }
    return attempt.current.key
  }
  const settle = (error?: unknown) => {
    if (error === undefined || !lost(error)) attempt.current = null
  }
  const changed = useCallback((next: ProjectPeople) => {
    setPeople(next)
    told.current(next)
  }, [])

  // ---- the add dialog: its choices, read again (debounced) as the person types ----------------------------------------------
  const readId = useRef(0)
  const kind = dialog?.kind ?? null
  const q = dialog?.q ?? ''
  const readChoices = useCallback(
    (asked: 'team' | 'outside', typed: string, signal?: AbortSignal) => {
      const id = ++readId.current
      peopleChoices(api, project.id, typed, signal)
        .then((answer) => {
          if (id !== readId.current) return
          setDialog((now) => (now && now.kind === asked ? { ...now, choices: choicesFor(asked, answer), mayAddOutside: answer.mayAddOutside, problem: null } : now))
        })
        .catch((error: unknown) => {
          if ((error as { name?: string } | null)?.name === 'AbortError' || id !== readId.current) return
          setDialog((now) => (now && now.kind === asked ? { ...now, choices: null, problem: readProblem(error) } : now))
        })
    },
    [api, project.id],
  )
  useEffect(() => {
    if (kind === null) return
    const controller = new AbortController()
    const timer = setTimeout(() => readChoices(kind, q, controller.signal), q === '' ? 0 : 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [kind, q, readChoices])

  const pick = useCallback(
    async (userId: string) => {
      if (!dialog || dialog.busy || offline) return
      const name = dialog.choices?.find((person) => person.userId === userId)?.name ?? ''
      const asked = dialog.kind
      setDialog({ ...dialog, busy: userId, notice: null })
      try {
        const next = await addPerson(api, project.id, userId, keyFor(`add:${userId}`))
        settle()
        changed(next)
        setDialog(null)
        setNotice(addedNotice(asked, name))
      } catch (error) {
        settle(error)
        const refused = writeProblem(error)
        setDialog((now) => (now ? { ...now, busy: null, notice: { ...refused, tone: 'danger' } } : now))
        // Someone changed the people first: read them and the choices again.
        if (refused.stale) {
          readPeople(api, project.id).then(changed).catch(() => undefined)
          readChoices(asked, dialog.q)
        }
      }
    },
    // keyFor / settle read refs only.
    [dialog, offline, api, project.id, changed, readChoices],
  )

  // ---- take out, leave -------------------------------------------------------------------------------------------------------
  const out = useCallback(async () => {
    if (!confirm || confirm.busy || offline) return
    const row = confirm.row
    setConfirm({ ...confirm, busy: true, notice: null })
    try {
      let next: ProjectPeople
      if (confirm.kind === 'leave') {
        await setMyFollow(api, { type: 'Project', id: project.id }, { following: false, muted: false })
        next = await readPeople(api, project.id)
        settle()
      } else {
        next = await removePerson(api, project.id, row.userId ?? '', keyFor(`remove:${row.userId ?? ''}`))
        settle()
      }
      changed(next)
      setConfirm(null)
      setNotice(confirm.kind === 'leave' ? { key: 'notice.left', tone: 'success' } : { key: 'notice.removed', params: { name: row.name }, tone: 'success' })
    } catch (error) {
      settle(error)
      const refused = writeProblem(error)
      setConfirm((now) => (now ? { ...now, busy: false, notice: { ...refused, tone: 'danger' } } : now))
      if (refused.stale) readPeople(api, project.id).then(changed).catch(() => undefined)
    }
  }, [confirm, offline, api, project.id, changed])

  const busy = Boolean(dialog?.busy) || Boolean(confirm?.busy)
  const model = useMemo(
    () =>
      peopleBlockOf({
        people,
        facts: { project, meId, offline, busy },
        now: Date.now(),
        notice,
        dialog: dialog ? { ...dialog, offline } : null,
        confirm,
      }),
    [people, project, meId, offline, busy, notice, dialog, confirm],
  )

  return (
    <PeopleBlock
      model={model}
      actions={{
        onAdd: (asked) => {
          const button = asked === 'team' ? model.addTeam : model.addOutside
          if (button.held || !button.offered) return
          attempt.current = null
          setNotice(null)
          setDialog({ kind: asked, q: '', choices: null, problem: null, mayAddOutside: false, busy: null, notice: null })
        },
        onOut: (row: PersonRow) => {
          if (!row.out || row.out.held) return
          attempt.current = null
          setConfirm({ kind: row.out.kind, row, busy: false, notice: null })
        },
        onDismissNotice: () => setNotice(null),
        dialog: {
          onQuery: (typed) => setDialog((now) => (now ? { ...now, q: typed, choices: null, problem: null } : now)),
          onPick: (userId) => void pick(userId),
          onRetry: () => dialog && readChoices(dialog.kind, dialog.q),
          onClose: () => {
            if (dialog?.busy) return
            setDialog(null)
          },
        },
        confirm: {
          onConfirm: () => void out(),
          onCancel: () => {
            if (confirm?.busy) return
            setConfirm(null)
          },
        },
      }}
    />
  )
}
