'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { STEP_UP_CLOSED, useStepUp, type StepUpState } from '../../../quality/_shared/hooks'
import { valueOf, type Read } from '../model'
import type { TabContext } from '../use-settings'
import { evidenceAddress, readTemplates, recordApproval, sendEvidence, withdrawApproval, type TemplatesAnswer } from './api'
import { emptyRecordDraft, ppeProblemOf, readProblemOf, recordBodyOf, templateKeyOf, templateOf, type PpeProblem, type RecordDraft } from './model'

export interface Writing {
  readonly busy: boolean
  readonly problem: PpeProblem | null
}
const IDLE: Writing = Object.freeze({ busy: false, problem: null })

export interface TemplatesState {
  readonly read: Read<TemplatesAnswer>
  /** Record a consultant's yes (`?add=1`; from a template's window: that template). */
  readonly record: { readonly draft: RecordDraft; readonly writing: Writing } | null
  /** Withdraw one approval (inside the template's window). */
  readonly withdraw: { readonly approvalId: string; readonly reason: string; readonly writing: Writing } | null
  readonly stepUp: StepUpState
  /** A notice after a write (a message key of this tab's catalogue). */
  readonly notice: { readonly tone: 'success' | 'danger'; readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
}

export interface TemplatesActions {
  onRetry?: () => void
  onRecordDraft?: (draft: RecordDraft) => void
  onRecordSave?: () => void
  onWithdrawStart?: (approvalId: string) => void
  onWithdrawReason?: (reason: string) => void
  onWithdrawSave?: () => void
  onWithdrawCancel?: () => void
  /** Opens the consultant's file in a new tab (its 60-second address). */
  onOpenFile?: (fileId: string) => void
  onDismissNotice?: () => void
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
}

export const EMPTY_TEMPLATES_STATE: TemplatesState = Object.freeze({ read: { status: 'loading' } as const, record: null, withdraw: null, stepUp: STEP_UP_CLOSED, notice: null })

/**
 * Templates (B-W2b-288, FU2:01): reads only while the tab shows (and again on `compliance_ppe_texts.approval_changed`); the record
 * dialog announces the consultant's file once per file and company (the same approval id on a retry), then records the yes —
 * the API's 403 `stepUp` opens this tab's own code dialog and the same call runs again with the same key; a withdrawal is one
 * call. Every refusal is said in this tab's words.
 */
export function useTemplates(context: TabContext): { state: TemplatesState; actions: TemplatesActions } {
  const { api, active, can, address, go, stamp, tick, companyId } = context
  const [read, setRead] = useState<Read<TemplatesAnswer>>({ status: 'loading' })
  const [record, setRecord] = useState<TemplatesState['record']>(null)
  const [withdraw, setWithdraw] = useState<TemplatesState['withdraw']>(null)
  const [notice, setNotice] = useState<TemplatesState['notice']>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const turn = useRef(0)
  const sent = useRef<{ file: File; scope: string; approvalId: string; fileId: string } | null>(null)

  const load = useCallback(
    async (quiet = false) => {
      if (!can.view) return
      const mine = ++turn.current
      if (!quiet) setRead({ status: 'loading' })
      try {
        const value = await readTemplates(api, companyId)
        if (mine === turn.current) {
          setRead({ status: 'ready', value })
          stamp()
        }
      } catch (error) {
        if (mine === turn.current) setRead({ status: 'error', problem: readProblemOf(error) })
      }
    },
    [api, can.view, companyId, stamp],
  )
  useEffect(() => {
    if (active) void load()
  }, [active, load])
  useEffect(() => {
    if (active && tick > 0) void load(true)
  }, [tick])

  const answer = valueOf(read)
  // `?add=1` opens the record dialog (for the template whose window is open, if any).
  useEffect(() => {
    if (!active || !address.add) return setRecord(null)
    if (record) return
    const opened = templateOf(answer, address.open)
    setRecord({ draft: emptyRecordDraft(opened ? templateKeyOf(opened) : null, !!answer?.mayRecord.company), writing: IDLE })
  }, [active, address.add, answer])
  useEffect(() => {
    if (!address.open) setWithdraw(null)
  }, [address.open])

  const actions: TemplatesActions = {
    onRetry: () => void load(),
    onRecordDraft: (draft) => setRecord((current) => (current ? { ...current, draft, writing: current.writing.problem ? IDLE : current.writing } : current)),
    onRecordSave: () => {
      if (!record || !answer) return
      const draft = record.draft
      const template = templateOf(answer, draft.template)
      const body = recordBodyOf(draft, template, companyId)
      if (!body || !draft.file) return
      const key = newIdempotencyKey()
      setRecord({ draft, writing: { busy: true, problem: null } })
      void (async () => {
        try {
          const scope = `${draft.scope}:${body.companyId ?? ''}`
          if (!sent.current || sent.current.file !== draft.file || sent.current.scope !== scope) sent.current = { file: draft.file!, scope, ...(await sendEvidence(api, body.companyId, draft.file!)) }
          const files = { approvalId: sent.current.approvalId, fileId: sent.current.fileId }
          await guard('ppe.stepUp.record', () => recordApproval(api, files, body, key))
          sent.current = null
          setRecord(null)
          setNotice({ tone: 'success', key: 'ppe.notice.recorded', params: { languages: body.languages.join(', ') } })
          go({ add: false, open: draft.template })
          void load(true)
        } catch (error) {
          setRecord((current) => (current ? { ...current, writing: { busy: false, problem: ppeProblemOf(error) } } : current))
        }
      })()
    },
    onWithdrawStart: (approvalId) => setWithdraw({ approvalId, reason: '', writing: IDLE }),
    onWithdrawReason: (reason) => setWithdraw((current) => (current ? { ...current, reason, writing: current.writing.problem ? IDLE : current.writing } : current)),
    onWithdrawCancel: () => setWithdraw(null),
    onWithdrawSave: () => {
      const approval = withdraw ? answer?.approvals.find((entry) => entry.id === withdraw.approvalId) : null
      if (!withdraw || !approval) return
      setWithdraw({ ...withdraw, writing: { busy: true, problem: null } })
      void withdrawApproval(api, approval, withdraw.reason.trim()).then(
        () => {
          setWithdraw(null)
          setNotice({ tone: 'success', key: 'ppe.notice.withdrawn' })
          void load(true)
        },
        (error) => setWithdraw((current) => (current ? { ...current, writing: { busy: false, problem: ppeProblemOf(error) } } : current)),
      )
    },
    onOpenFile: (fileId) => {
      // The file's short-lived address, opened in a new tab right after the click.
      void evidenceAddress(api, fileId).then(
        (url) => void window.open(url, '_blank', 'noopener'),
        () => setNotice({ tone: 'danger', key: 'ppe.notice.fileFailed' }),
      )
    },
    onDismissNotice: () => setNotice(null),
    onStepUp: (code) => void submitStepUp(code),
    onStepUpCancel: cancelStepUp,
  }
  return { state: { read, record, withdraw, stepUp, notice }, actions }
}
