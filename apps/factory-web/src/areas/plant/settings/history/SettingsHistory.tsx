'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readHistory } from '../depth-api'
import { depthReadProblem } from '../depth-model'
import { HistoryView, type HistoryModel } from './view/HistoryView'

/** `/w/<company>/plant/settings/history` (SCR-241 tab:audit, a new tab): every change of Plant settings the person may read (audit.read). */
export function SettingsHistory() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const canRead = useMemo(() => session.permissions.includes('audit.read'), [session.permissions])
  const [read, setRead] = useState<HistoryModel['read']>({ status: 'loading' })
  const load = useCallback(async () => {
    if (!canRead) return
    setRead({ status: 'loading' })
    try {
      setRead({ status: 'ready', value: await readHistory(api) })
    } catch (error) {
      setRead({ status: 'error', problem: depthReadProblem(error) })
    }
  }, [api, canRead])
  useEffect(() => void load(), [load])
  const sites = useMemo(() => scope.sites.map((site) => ({ id: site.id, name: site.name })), [scope.sites])
  return <HistoryView model={{ canRead, read, sites }} actions={{ onRetry: () => void load() }} />
}
