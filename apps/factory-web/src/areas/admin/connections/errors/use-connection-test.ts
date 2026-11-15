'use client'

import { useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { problemKey } from '../../shared/model'
import { reconnectConnection, testConnection, type TestAnswer } from './api'
import type { ConnectionTestActions, ConnectionTestModel } from './view/ConnectionTest'

/**
 * A connection's Test and Reconnect (B-W2b-415; PLT-196): `POST /integrations/accounts/:id/test` or `…/reconnect`
 * (integrations.manage); the answer opens in the record's toggletip; `onDone` reads the account again (its last OK or last
 * error moved).
 */
export function useConnectionTest(
  api: ApiClient,
  account: ConnectionTestModel['account'] | null,
  options: { readonly canManage: boolean; readonly onDone?: () => void },
): { model: ConnectionTestModel | null; actions: ConnectionTestActions } {
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState<ConnectionTestModel['running']>(null)
  const [answer, setAnswer] = useState<TestAnswer | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const run = async (kind: 'test' | 'reconnect') => {
    if (!account || running) return
    setOpen(true)
    setRunning(kind)
    setProblem(null)
    try {
      setAnswer(await (kind === 'test' ? testConnection(api, account.id) : reconnectConnection(api, account.id)))
      options.onDone?.()
    } catch (error) {
      setProblem(problemKey(error))
    } finally {
      setRunning(null)
    }
  }

  return {
    model: account ? { account, canManage: options.canManage, open, running, answer: answer?.accountId === account.id ? answer : null, problem } : null,
    actions: {
      onTest: () => void run('test'),
      onReconnect: () => void run('reconnect'),
      onClose: () => setOpen(false),
    },
  }
}
