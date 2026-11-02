'use client'

import { useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readProblem } from '../../_shared/model'
import { settingsHistory } from '../api'
import { settingsCan } from '../model'
import { HistoryView, type HistoryModel } from './view/HistoryView'

/** `/w/<company>/people/settings/history` (SCR-265 tab:audit): every change of these settings the person may read, newest first (audit.read). */
export function SettingsHistory() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => settingsCan(session.permissions), [session.permissions])
  const [read, setRead] = useState<HistoryModel['read']>({ status: 'loading' })
  useEffect(() => {
    if (!can.audit) return setRead({ status: 'error', problem: 'problem.forbidden' })
    let live = true
    settingsHistory(api)
      .then((value) => live && setRead({ status: 'ready', value }))
      .catch((error: unknown) => live && setRead({ status: 'error', problem: readProblem(error) }))
    return () => {
      live = false
    }
  }, [api, can.audit])
  return <HistoryView model={{ read }} />
}
