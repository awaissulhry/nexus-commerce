'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { getCompany } from '../../shared/api'
import { failed, problemKey, problemNotice, type Notice } from '../../shared/model'
import { useRecordTab, useThreadDock } from '../../shared/record-hooks'
import { getAccount, listCalls, listInbound, setPaused, type InboundDelivery, type InboundStatus, type IntegrationAccount, type IntegrationCall } from '../api'
import { CONNECTION_TABS, type Ledger, type PauseConfirm } from '../model'
import { ConnectionRecordView } from './view/ConnectionRecordView'

const LOADING = { items: null, problem: null, more: null }

/**
 * `/w/<company>/admin/connections/<id>` (SCR-087 Connection record): the account (`GET /integrations/accounts/:id`),
 * its company's name (with companies.view), its call ledger and received webhooks, page by page (newest first, 50 a
 * page); pause and resume with the version read. The record panels hang on `IntegrationAccount`.
 */
export function ConnectionRecord({ accountId }: { accountId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(CONNECTION_TABS)
  const { dockOpen, toggleDock } = useThreadDock('IntegrationAccount')
  const [account, setAccount] = useState<IntegrationAccount | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const [calls, setCalls] = useState<Ledger<IntegrationCall>>(LOADING)
  const [failedOnly, setFailedOnly] = useState(false)
  const [inbound, setInbound] = useState<Ledger<InboundDelivery>>(LOADING)
  const [inboundStatus, setInboundStatus] = useState<InboundStatus | null>(null)
  const [confirm, setConfirm] = useState<PauseConfirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())

  const load = useCallback(async () => {
    setNow(new Date().toISOString())
    try {
      const found = await getAccount(api, accountId)
      setAccount(found)
      setProblem(null)
      if (found.companyId && held.has('companies.view')) {
        getCompany(api, found.companyId).then(
          (answer) => setCompanyName(answer.company.legalName),
          () => setCompanyName(null),
        )
      }
    } catch (error) {
      setProblem(problemKey(error))
    }
  }, [api, accountId, held])
  useEffect(() => {
    void load()
  }, [load])

  const readCalls = useCallback(
    async (before: string | null) => {
      setCalls((current) => (before ? { ...current, loadingMore: true } : LOADING))
      try {
        const answer = await listCalls(api, accountId, { failed: failedOnly, before })
        setCalls((current) => ({ items: before ? [...(current.items ?? []), ...answer.calls] : answer.calls, problem: null, more: answer.nextBefore }))
      } catch (error) {
        setCalls({ ...failed<IntegrationCall>(problemKey(error)), more: null })
      }
    },
    [api, accountId, failedOnly],
  )
  const readInbound = useCallback(
    async (before: string | null) => {
      setInbound((current) => (before ? { ...current, loadingMore: true } : LOADING))
      try {
        const answer = await listInbound(api, accountId, { status: inboundStatus, before })
        setInbound((current) => ({ items: before ? [...(current.items ?? []), ...answer.inbound] : answer.inbound, problem: null, more: answer.nextBefore }))
      } catch (error) {
        setInbound({ ...failed<InboundDelivery>(problemKey(error)), more: null })
      }
    },
    [api, accountId, inboundStatus],
  )
  useEffect(() => {
    if (tab === 'calls') void readCalls(null)
  }, [tab, readCalls])
  useEffect(() => {
    if (tab === 'inbound') void readInbound(null)
  }, [tab, readInbound])

  return (
    <ConnectionRecordView
      model={{ prefix, tab, account, problem: account ? null : problem, companyName, can: { manage: held.has('integrations.manage') }, calls, failedOnly, inbound, inboundStatus, confirm, busy, dialogProblem, notice, dockOpen, now }}
      panels={account ? <RecordPanels record={{ type: 'IntegrationAccount', id: account.id, companyId: account.companyId, siteId: null }} title={account.label} /> : null}
      actions={{
        onConfirm: (next) => {
          setDialogProblem(null)
          setConfirm(next)
        },
        onSwitch: async (current, pause, reason) => {
          setBusy(true)
          setDialogProblem(null)
          try {
            const next = await setPaused(api, current.id, pause, { version: current.version, ...(reason ? { reason } : {}) })
            setAccount(next)
            setConfirm(null)
            setNotice({ key: pause ? 'conn.done.paused' : 'conn.done.resumed', tone: 'success', params: { name: next.label } })
            return true
          } catch (error) {
            setDialogProblem(problemNotice(error).key)
            if (isApiError(error) && error.kind === 'conflict') void load()
            return false
          } finally {
            setBusy(false)
          }
        },
        onFailedOnly: setFailedOnly,
        onMoreCalls: () => void readCalls(calls.more),
        onInboundStatus: setInboundStatus,
        onMoreInbound: () => void readInbound(inbound.more),
        onDock: toggleDock,
        onRetry: () => {
          setProblem(null)
          void load()
        },
        onRetryCalls: () => void readCalls(null),
        onRetryInbound: () => void readInbound(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
