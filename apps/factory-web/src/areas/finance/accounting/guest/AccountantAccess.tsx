'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, useStepUp } from '../../_shared/hooks'
import { changeAccountant, endAccountant, fetchAccountants, inviteAccountant, type Accountants } from './api'
import { accountantRows, blankInvite, dayOf, endOfDay, inviteBody, inviteProblems, untilDay, writeProblemKey, type AccountantRow, type InviteDraft } from './model'
import { AccountantAccessView, type AccountantAccessActions, type AccountantAccessModel } from './view/AccountantAccessView'

/**
 * Accountant access on Finance › Close › Accounting export (B-W2b-201): reads GET /accounting/accountants for the page's
 * company and gives, moves and ends the accountant's guest portal through the accounting routes (finance's
 * accounting.accountants.manage; never partners.*). Every change asks a fresh authenticator code first (the office
 * step-up), with ONE Idempotency-Key per opened dialog; the list reads again after each. The accountant reads the
 * period's files in its own portal, `/p/<firm>/accounting`.
 */
export function AccountantAccess() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const companyId = session.company?.id ?? null
  const companyName = session.company?.name ?? ''
  const today = dayOf(new Date())
  const [read, setRead] = useState<{ state: 'loading' | 'error' | 'ready'; value: Accountants | null }>({ state: 'loading', value: null })
  const [showLeft, setShowLeft] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState<AccountantAccessModel['notice']>(null)
  const [invite, setInvite] = useState<{ draft: InviteDraft; problem: string | null; busy: boolean } | null>(null)
  const [change, setChange] = useState<{ row: AccountantRow; until: string; problem: string | null; busy: boolean } | null>(null)
  const [end, setEnd] = useState<{ rows: readonly AccountantRow[]; reason: string; problem: string | null; busy: boolean } | null>(null)
  const key = useRef<string | null>(null)
  const steps = useStepUp(api)

  const load = useCallback(async () => {
    if (!companyId) return
    try {
      const value = await fetchAccountants(api, companyId)
      setRead({ state: 'ready', value })
    } catch {
      setRead((current) => ({ state: current.value ? 'ready' : 'error', value: current.value }))
    }
  }, [api, companyId])

  useEffect(() => {
    void load()
  }, [load])

  const sentence = 'office.stepUp'
  const guarded = async <T,>(work: () => Promise<T>): Promise<T> => {
    await steps.ensureFresh(sentence)
    return steps.guard(sentence, work)
  }

  const actions: AccountantAccessActions = {
    onRetry: () => void load(),
    onShowLeft: (show) => setShowLeft(show),
    onSelect: (ids) => setSelected(ids),
    onOpenInvite: () => {
      key.current = newIdempotencyKey()
      setInvite({ draft: blankInvite(read.value?.firms ?? [], today), problem: null, busy: false })
    },
    onInvite: (patch) => setInvite((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onSendInvite: () => {
      if (!invite || !companyId || Object.keys(inviteProblems(invite.draft, today)).length > 0) return
      const draft = invite.draft
      setInvite({ ...invite, busy: true, problem: null })
      void guarded(() => inviteAccountant(api, inviteBody(companyId, draft), key.current ?? newIdempotencyKey()))
        .then((answer) => {
          setInvite(null)
          setNotice({ key: answer.portalSwitchedOn ? 'office.done.invitedOn' : 'office.done.invited', params: { name: draft.displayName.trim(), email: answer.invitation.email }, tone: 'success' })
          void load()
        })
        .catch((error: unknown) => setInvite((current) => (current ? { ...current, busy: false, problem: isStepUpCancelled(error) ? null : writeProblemKey(error) } : current)))
    },
    onOpenChange: (row) => {
      key.current = newIdempotencyKey()
      setChange({ row, until: untilDay(row.accessUntil), problem: null, busy: false })
    },
    onChangeUntil: (until) => setChange((current) => (current ? { ...current, until, problem: null } : current)),
    onSendChange: () => {
      if (!change || !companyId || !change.until) return
      const { row, until } = change
      setChange({ ...change, busy: true, problem: null })
      void guarded(() => changeAccountant(api, row.id, { companyId, version: row.version, accessUntil: endOfDay(until) }, key.current ?? newIdempotencyKey()))
        .then(() => {
          setChange(null)
          setNotice({ key: 'office.done.changed', params: { name: row.displayName }, tone: 'success' })
          void load()
        })
        .catch((error: unknown) => setChange((current) => (current ? { ...current, busy: false, problem: isStepUpCancelled(error) ? null : writeProblemKey(error) } : current)))
    },
    onOpenEnd: (rows) => {
      key.current = newIdempotencyKey()
      setEnd({ rows, reason: '', problem: null, busy: false })
    },
    onEndReason: (reason) => setEnd((current) => (current ? { ...current, reason } : current)),
    onSendEnd: () => {
      if (!end || !companyId) return
      const { rows, reason } = end
      setEnd({ ...end, busy: true, problem: null })
      const base = key.current ?? newIdempotencyKey()
      void guarded(async () => {
        for (const [index, row] of rows.entries()) await endAccountant(api, row.id, { companyId, version: row.version, ...(reason.trim() ? { reason: reason.trim() } : {}) }, `${base}:${index}`)
      })
        .then(() => {
          setEnd(null)
          setSelected([])
          setNotice({ key: 'office.done.ended', params: { count: rows.length, name: rows[0]?.displayName ?? '' }, tone: 'success' })
          void load()
        })
        .catch((error: unknown) => {
          setEnd((current) => (current ? { ...current, busy: false, problem: isStepUpCancelled(error) ? null : writeProblemKey(error) } : current))
          void load()
        })
    },
    onClose: () => {
      setInvite(null)
      setChange(null)
      setEnd(null)
    },
    onDismissNotice: () => setNotice(null),
    onStepUpSubmit: (code) => void steps.submitStepUp(code),
    onStepUpCancel: () => steps.cancelStepUp(),
  }

  const value = read.value
  const model: AccountantAccessModel = {
    state: companyId ? read.state : 'error',
    companyName,
    firms: value?.firms ?? [],
    rows: value ? accountantRows(value, showLeft) : null,
    showLeft,
    downloads: value?.downloads ?? null,
    may: value?.may.manage ?? false,
    selected,
    busy: invite?.busy || change?.busy || end?.busy ? 'act' : null,
    notice,
    invite: invite ? { ...invite, problems: inviteProblems(invite.draft, today), today } : null,
    change: change ? { ...change, today } : null,
    end,
    stepUp: { open: steps.stepUp.open, busy: steps.stepUp.busy, problem: steps.stepUp.problem },
  }
  return <AccountantAccessView model={model} actions={actions} />
}
