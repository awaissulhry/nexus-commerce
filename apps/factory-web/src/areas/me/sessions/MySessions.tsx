'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi } from '../../../lib/session/context'
import { endMySession, endOtherSessions, mySessions } from './api'
import { othersOf, sessionProblem, type SessionsRead } from './model'
import { MySessionsCard, type MySessionsModel } from './view/MySessionsCard'

/**
 * My profile › Where I'm signed in (SCR-007, B-W2b-413): `GET /auth/sessions` (any office session), read again when the tab
 * comes back; End = `POST /auth/sessions/:id/end`; "Sign out everywhere else" = `POST /auth/sessions/end-others` after the
 * ActionConfirm. Ending only narrows: no fresh code is asked (B-W2b-404).
 */
export function MySessions() {
  const api = useOfficeApi()
  const [read, setRead] = useState<SessionsRead>({ state: 'loading' })
  const [confirm, setConfirm] = useState<MySessionsModel['confirm']>(null)
  const [ending, setEnding] = useState<string | null>(null)
  const [notice, setNotice] = useState<MySessionsModel['notice']>(null)

  const load = useCallback(() => {
    mySessions(api).then(
      (sessions) => setRead({ state: 'ok', sessions }),
      (error: unknown) => setRead({ state: 'failed', problem: sessionProblem(error) }),
    )
  }, [api])
  useEffect(() => {
    load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const end = async (sessionId: string) => {
    if (ending) return
    setEnding(sessionId)
    try {
      await endMySession(api, sessionId)
      setNotice({ key: 'me.done.one', tone: 'success' })
    } catch (error) {
      setNotice({ key: sessionProblem(error), tone: 'warning' })
    } finally {
      setEnding(null)
      load()
    }
  }

  const endOthers = async () => {
    if (!confirm || confirm.busy) return
    setConfirm({ busy: true, problem: null })
    try {
      const answer = await endOtherSessions(api)
      setConfirm(null)
      setNotice({ key: 'me.done.others', tone: 'success', params: { count: answer.ended } })
      load()
    } catch (error) {
      setConfirm({ busy: false, problem: sessionProblem(error) })
    }
  }

  return (
    <MySessionsCard
      model={{ read, confirm, ending, notice }}
      actions={{
        onRetry: () => {
          setRead({ state: 'loading' })
          load()
        },
        onEnd: (sessionId) => void end(sessionId),
        onEndOthers: () => {
          if (read.state === 'ok' && othersOf(read.sessions) > 0) setConfirm({ busy: false, problem: null })
        },
        onConfirm: () => void endOthers(),
        onCancel: () => setConfirm(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
