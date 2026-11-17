'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectLinkType } from '@nexus/factory-domain/projects/rules'
import { SEARCH_LIMITS } from '@nexus/factory-domain/search/text'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { searchRecords } from '../../../../search/api'
import { linkRecord, unlinkRecord, type ProjectLinks, type ProjectView } from '../../api'
import { readProblem, writeProblem, type Notice } from '../../model'
import {
  candidatesOf,
  groupsOf,
  keepsKey,
  linkBody,
  linkedNotice,
  linkHeld,
  linkProblemOf,
  noteProblem,
  scopePhrase,
  unlinkedNotice,
  type LinkDialogModel,
  type LinkedBlockModel,
  type LinkedRow,
} from './model'
import { LinkedBlock } from './view/LinkedBlock'

/**
 * B-TH-251 — the Linked block's container (PROJ.linked-F01…F05, F07): the page's linked records (GET /projects/:id read them) as its
 * starting state; Link… searches the office search (GET /search, kept to the kinds a project links and the project's company) and
 * links the record picked (POST …/links, one Idempotency-Key per attempt; the same key again only after a lost answer); Unlink… asks
 * first, then DELETE …/links/:linkId. After each, the API's linked records are the block's and go to the page (`onChanged`). A refusal
 * is said from its code in words that name neither company (W12, W27, W38).
 */
export interface LinkedSectionProps {
  readonly project: ProjectView
  readonly links: ProjectLinks
  readonly offline: boolean
  readonly onChanged: (links: ProjectLinks) => void
}

const EMPTY_DIALOG = (project: ProjectView): LinkDialogModel => ({
  project: `${project.number} · ${project.name}`,
  scope: scopePhrase(project),
  q: '',
  kind: null,
  results: { status: 'idle' },
  picked: null,
  note: '',
  busy: false,
  problem: null,
  offline: false,
})

export function LinkedSection({ project, links, offline, onChanged }: LinkedSectionProps) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [current, setCurrent] = useState<ProjectLinks>(links)
  useEffect(() => setCurrent(links), [links])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<LinkDialogModel | null>(null)
  const [unlinking, setUnlinking] = useState<LinkedBlockModel['unlinking']>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const linkKey = useRef<string | null>(null)
  const searchSeq = useRef(0)
  const searchAbort = useRef<AbortController | null>(null)
  useEffect(() => () => searchAbort.current?.abort(), [])
  const told = useRef(onChanged)
  told.current = onChanged

  const held = linkHeld(project, offline)
  const changed = useCallback((next: ProjectLinks) => {
    setCurrent(next)
    told.current(next)
  }, [])

  // ---- the search ----------------------------------------------------------------------------------------------------------
  const runSearch = useCallback(
    (q: string, kind: ProjectLinkType | null) => {
      searchAbort.current?.abort()
      const text = q.trim()
      if (text === '') {
        setDialog((now) => (now ? { ...now, q, kind, results: { status: 'idle' } } : now))
        return
      }
      if (text.length < SEARCH_LIMITS.minQuery) {
        setDialog((now) => (now ? { ...now, q, kind, results: { status: 'tooShort' } } : now))
        return
      }
      const seq = ++searchSeq.current
      const controller = new AbortController()
      searchAbort.current = controller
      setDialog((now) => (now ? { ...now, q, kind, results: { status: 'loading' } } : now))
      searchRecords(api, { q: text, type: kind, limit: kind ? SEARCH_LIMITS.page : SEARCH_LIMITS.maxPage }, controller.signal)
        .then((answer) => {
          if (seq !== searchSeq.current) return
          if (answer.tooShort) {
            setDialog((now) => (now ? { ...now, results: { status: 'tooShort' } } : now))
            return
          }
          setDialog((now) => (now ? { ...now, results: { status: 'ready', items: candidatesOf(answer.results, project, current) } } : now))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || seq !== searchSeq.current) return
          setDialog((now) => (now ? { ...now, results: { status: 'error', problem: readProblem(error) } } : now))
        })
    },
    [api, project, current],
  )

  // ---- link ------------------------------------------------------------------------------------------------------------------
  const submitLink = useCallback(async () => {
    const model = dialog
    if (!model || model.busy || !model.picked || held || noteProblem(model.note)) return
    const picked = model.picked
    setDialog({ ...model, busy: true, problem: null })
    linkKey.current ??= newIdempotencyKey()
    try {
      const next = await linkRecord(api, project.id, linkBody(picked, model.note), linkKey.current)
      linkKey.current = null
      changed(next)
      setDialog(null)
      setNotice(linkedNotice(picked.label))
    } catch (error) {
      if (!keepsKey(error)) linkKey.current = null
      setDialog((now) => (now ? { ...now, busy: false, problem: linkProblemOf(error, picked.label) } : now))
    }
  }, [dialog, held, api, project.id, changed])

  // ---- unlink ----------------------------------------------------------------------------------------------------------------
  const confirmUnlink = useCallback(async () => {
    const asked = unlinking
    if (!asked || busy || held) return
    setBusy(asked.linkId)
    try {
      const next = await unlinkRecord(api, project.id, asked.linkId)
      changed(next)
      setNotice(asked.label ? unlinkedNotice(asked.label) : { key: 'notice.unlinkedHidden', tone: 'success' })
    } catch (error) {
      setNotice({ ...writeProblem(error), tone: 'danger' })
    } finally {
      setBusy(null)
      setUnlinking(null)
    }
  }, [unlinking, busy, held, api, project.id, changed])

  const model = useMemo<LinkedBlockModel>(
    () => ({
      count: current.count,
      groups: groupsOf(current.records, prefix, OFFICE_PAGES),
      scope: scopePhrase(project),
      held,
      manage: project.may.manage,
      busy,
      notice,
      link: dialog ? { ...dialog, offline } : null,
      unlinking,
    }),
    [current, prefix, project, held, busy, notice, dialog, offline, unlinking],
  )

  return (
    <LinkedBlock
      model={model}
      actions={{
        onLink: () => {
          linkKey.current = null
          setDialog(EMPTY_DIALOG(project))
        },
        onUnlink: (row: LinkedRow) => setUnlinking({ linkId: row.linkId, recordType: row.recordType, label: row.label }),
        onConfirmUnlink: () => void confirmUnlink(),
        onCancelUnlink: () => setUnlinking(null),
        onDismissNotice: () => setNotice(null),
        link: {
          onQuery: (q) => runSearch(q, dialog?.kind ?? null),
          onKind: (kind) => runSearch(dialog?.q ?? '', kind),
          onPick: (candidate) => {
            linkKey.current = null
            setDialog((now) => (now ? { ...now, picked: { recordType: candidate.recordType, recordId: candidate.recordId, label: candidate.label }, problem: null } : now))
          },
          onNote: (note) => setDialog((now) => (now ? { ...now, note } : now)),
          onSubmit: () => void submitLink(),
          onRetry: () => dialog && runSearch(dialog.q, dialog.kind),
          onClose: () => {
            searchAbort.current?.abort()
            setDialog(null)
          },
        },
      }}
    />
  )
}
