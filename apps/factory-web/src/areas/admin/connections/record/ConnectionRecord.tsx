'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { getCompany } from '../../shared/api'
import { failed, problemKey, problemNotice, type Notice } from '../../shared/model'
import { getAccount, listCalls, listInbound, setPaused, type InboundDelivery, type InboundStatus, type IntegrationAccount, type IntegrationCall } from '../api'
import { connectionTabOf, mayReadConnectionThread, type Ledger, type PauseConfirm } from '../model'
// ---- B-TH-269: the docked thread on the connection (RecordFrame; Activity's tools in its "⋯") ----
import { OfficeRecordThread } from '../../../_shared/record-thread/OfficeRecordThread'
import { printHref } from '../../../../shell/print/print-model'
import { ConnectionRecordView } from './view/ConnectionRecordView'
import { useConnectionTest } from '../errors/use-connection-test'
import { ConnectionTest } from '../errors/view/ConnectionTest'

const LOADING = { items: null, problem: null, more: null }

/**
 * `/w/<company>/admin/connections/<id>` (SCR-087 Connection record): the account (`GET /integrations/accounts/:id`),
 * its company's name (with companies.view), its call ledger and received webhooks, page by page (newest first, 50 a
 * page); pause and resume with the version read. B-TH-269: the account's thread (`IntegrationAccount`) docks beside every tab (notes
 * only — an admin record has no party, W03), only with threads.read AND integrations.view (B-TH-005: the API asks both);
 * `?tab=overview|settings|calls|inbound`, the old `activity` lands on Overview with the thread opened.
 */
export function ConnectionRecord({ accountId }: { accountId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = connectionTabOf(params?.get('tab'))
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
  // B-W2b-415: Test (one harmless call through the gateway) and Reconnect (the circuit closed first); the account read again after.
  const tester = useConnectionTest(api, account ? { id: account.id, status: account.status, mode: account.mode, provider: account.provider } : null, {
    canManage: held.has('integrations.manage'),
    onDone: () => {
      void load()
      if (tab === 'calls') void readCalls(null)
    },
  })
  useEffect(() => {
    if (tab === 'calls') void readCalls(null)
  }, [tab, readCalls])
  useEffect(() => {
    if (tab === 'inbound') void readInbound(null)
  }, [tab, readInbound])

  // B-TH-269: the account's thread docked beside every tab (notes only: no party on an admin record, W03), with threads.read AND
  // integrations.view (B-TH-005); Activity's tools are in its "⋯" (R-ACT). The print view keeps the record panels' print form.
  const record = account ? { type: 'IntegrationAccount', id: account.id, companyId: account.companyId, siteId: null } : null
  const mayThread = mayReadConnectionThread(held)
  const thread = account && record && mayThread ? <OfficeRecordThread docked record={record} title={account.label} recordLabel={account.label} party={null} printHref={printHref(pathname ?? '', params?.toString() ?? '')} /> : null
  const printThread = account && record && mayThread ? <RecordPanels record={record} title={account.label} /> : null

  return (
    <ConnectionRecordView
      model={{ prefix, tab, account, problem: account ? null : problem, companyName, can: { manage: held.has('integrations.manage') }, calls, failedOnly, inbound, inboundStatus, confirm, busy, dialogProblem, notice, now, personId: session.user.id /* B-TH-269 */ }}
      test={tester.model ? <ConnectionTest model={tester.model} actions={tester.actions} /> : undefined}
      testCard={tester.model ? <ConnectionTest model={tester.model} actions={tester.actions} place="card" /> : undefined}
      thread={thread}
      printThread={printThread}
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
