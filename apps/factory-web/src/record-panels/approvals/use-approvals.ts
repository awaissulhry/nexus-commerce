'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KIND_RULES } from '@nexus/factory-domain/approvals-out/kinds'
import type { ApiClient } from '../../lib/api/client'
import { useLocale } from '../../lib/i18n/provider'
import type { RecordKey } from '../api'
import { useLiveChanges } from '../live'
import { askApproval, readRecordRequests, withdrawApproval } from './api'
import {
  askDraftProblems,
  askedNotice,
  askFilesOf,
  askRefusal,
  defaultDueAt,
  newDraft,
  readProblemOf,
  takesApprovals,
  withdrawRefusal,
  type ApprovalsPanelActions,
  type ApprovalsPanelModel,
  type AskDraft,
} from './model'

export interface ApprovalsOptions {
  readonly api: ApiClient
  readonly record: RecordKey
  /** The record's label as the page shows it (the link's banner names it). */
  readonly title: string
  /** partners.approvals.view / partners.approvals.ask. */
  readonly can: { readonly view: boolean; readonly ask: boolean }
  /** The record's files as last read (null while read or not readable). */
  readonly files: ReadonlyArray<{ id: string; originalName: string; contentType: string; status: string; supersededAt?: string | null }> | null
  readonly party: { readonly name: string; readonly emails: readonly string[] } | null
  /** Reads the record's thread and history again after an ask or a withdrawal (the API writes there too). */
  readonly reloadPanels?: () => void
}

/**
 * The record panels' Approvals tab as RecordPanels mounts it (B-W2b-188): null for a record type no approval names or a
 * person without partners.approvals.view (no tab). It reads the record's requests, asks (one idempotent write; the link
 * given once is kept in memory only, until dismissed), withdraws (with the request's version), and reads again when the
 * live stream says a request of this record changed (approval_request.asked / answered / withdrawn / expired).
 */
export function useApprovals({ api, record, title, can, files, party, reloadPanels }: ApprovalsOptions): { model: ApprovalsPanelModel | null; actions: ApprovalsPanelActions } {
  const locale = useLocale()
  const enabled = can.view && takesApprovals(record.type)
  const [read, setRead] = useState<ApprovalsPanelModel['read']>({ status: 'loading' })
  const [ask, setAsk] = useState<ApprovalsPanelModel['ask']>(null)
  const [withdraw, setWithdraw] = useState<ApprovalsPanelModel['withdraw']>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ApprovalsPanelModel['notice']>(null)
  const [link, setLink] = useState<ApprovalsPanelModel['link']>(null)
  const latest = useRef({ read, ask, withdraw })
  latest.current = { read, ask, withdraw }

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      const answer = await readRecordRequests(api, record)
      setRead({ status: 'ready', kinds: answer.kinds, held: answer.held, requests: answer.requests })
    } catch (error) {
      setRead({ status: 'failed', problem: readProblemOf(error) })
    }
  }, [api, record, enabled])

  useEffect(() => {
    setRead({ status: 'loading' })
    void load()
  }, [load])

  useLiveChanges(
    {
      onChange: (change) => {
        if (!change.type.startsWith('approval_request.')) return
        if (change.fields.recordType !== record.type || change.fields.recordId !== record.id) return
        void load()
      },
      onReconnect: () => void load(),
    },
    enabled,
  )

  const askFiles = useMemo(() => askFilesOf(files?.map((file) => ({ id: file.id, name: file.originalName, contentType: file.contentType, status: file.status, supersededAt: file.supersededAt ?? null })) ?? null), [files])

  const send = async () => {
    const current = latest.current.ask
    if (!current || busy) return
    const now = Date.now()
    const problems = askDraftProblems(current.draft, now)
    if (Object.keys(problems).length > 0) {
      setAsk({ ...current, problems, problem: null })
      return
    }
    const draft = current.draft
    setBusy(true)
    try {
      const answer = await askApproval(api, {
        kind: draft.kind,
        recordType: record.type,
        recordId: record.id,
        question: draft.question.trim(),
        dueAt: draft.dueAt,
        fileIds: draft.fileIds,
        send: draft.send,
        ...(draft.send ? { email: draft.email.trim() } : {}),
        ...(draft.language ? { language: draft.language } : {}),
      })
      setAsk(null)
      setNotice(askedNotice(answer))
      if (answer.url) setLink({ url: answer.url, label: answer.request.record.words[locale] || title })
      await load()
      reloadPanels?.()
    } catch (error) {
      const refusal = askRefusal(error)
      setAsk((now) => (now ? { ...now, problems: refusal.problems, problem: refusal.problem } : now))
      if (refusal.reload) void load()
    } finally {
      setBusy(false)
    }
  }

  const confirmWithdraw = async () => {
    const current = latest.current.withdraw
    const state = latest.current.read
    const request = state.status === 'ready' ? state.requests.find((item) => item.id === current?.requestId) : undefined
    if (!current || !request || busy) return
    setBusy(true)
    setNotice(null)
    try {
      await withdrawApproval(api, request.id, request.version, current.reason.trim() || null)
      setWithdraw(null)
      setNotice({ key: 'note.withdrawn', tone: 'success', params: { kind: KIND_RULES[request.kind].name[locale] } })
      await load()
      reloadPanels?.()
    } catch (error) {
      setNotice({ key: withdrawRefusal(error), tone: 'danger' })
      void load()
    } finally {
      setBusy(false)
    }
  }

  const actions: ApprovalsPanelActions = {
    onRetry: () => {
      setRead({ status: 'loading' })
      void load()
    },
    onAsk: (open) => {
      setNotice(null)
      const state = latest.current.read
      setAsk(open && state.status === 'ready' ? { draft: newDraft(state.kinds, Date.now(), party?.emails ?? []), problems: {}, problem: null } : null)
    },
    onDraft: (change: Partial<AskDraft>) =>
      setAsk((current) => {
        if (!current) return current
        const draft = { ...current.draft, ...change }
        // A new kind starts at its own due time (and keeps the files only where they are allowed).
        if (change.kind && change.kind !== current.draft.kind) draft.dueAt = defaultDueAt(change.kind, Date.now())
        const cleared = { ...current.problems }
        for (const key of Object.keys(change)) delete cleared[key as keyof typeof cleared]
        if (change.kind) delete cleared.fileIds
        return { draft, problems: cleared, problem: null }
      }),
    onSend: () => void send(),
    onWithdraw: (requestId) => {
      setNotice(null)
      setWithdraw(requestId ? { requestId, reason: '' } : null)
    },
    onWithdrawReason: (reason) => setWithdraw((current) => (current ? { ...current, reason } : current)),
    onWithdrawConfirm: () => void confirmWithdraw(),
    onCopyLink: () => {
      if (link) void navigator.clipboard?.writeText(link.url).then(() => setNotice({ key: 'note.copied', tone: 'success' }), () => setNotice({ key: 'note.copyFailed', tone: 'warning' }))
    },
    onDismissLink: () => setLink(null),
    onDismissNotice: () => setNotice(null),
  }

  if (!enabled) return { model: null, actions }
  return {
    model: { can: { ask: can.ask }, read, ask, files: askFiles, party, withdraw, busy, notice, link },
    actions,
  }
}
