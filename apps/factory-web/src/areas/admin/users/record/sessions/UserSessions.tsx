'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi } from '../../../../../lib/session/context'
import { sessionProblem, type SessionsRead } from '../../../../me/sessions/model'
import { problemKey } from '../../../shared/model'
import { endUserSessions, userSessions } from './api'
import { UserSessionsTab, type UserSessionsModel } from './view/UserSessionsTab'

/**
 * The person's Sessions & sign-ins tab (SCR-011, B-W2b-413): `GET /auth/users/:id/sessions` (users.sessions.manage), read
 * again when the tab comes back (never one's own: My profile lists them); "End all sessions" = `POST /auth/users/:id/sessions/end` with the optional reason. No fresh
 * code: ending only narrows (B-W2b-404).
 */
export function UserSessions({ prefix, userId, name, self }: { prefix: string; userId: string; name: string; self: boolean }) {
  const api = useOfficeApi()
  const [read, setRead] = useState<SessionsRead>({ state: 'loading' })
  const [confirm, setConfirm] = useState<UserSessionsModel['confirm']>(null)
  const [notice, setNotice] = useState<UserSessionsModel['notice']>(null)

  const load = useCallback(() => {
    // One's own sessions are not read here (the API refuses them: 409 sessions/self): My profile lists them.
    if (self) return
    userSessions(api, userId).then(
      (sessions) => setRead({ state: 'ok', sessions }),
      (error: unknown) => setRead({ state: 'failed', problem: sessionProblem(error) }),
    )
  }, [api, userId, self])
  useEffect(() => {
    load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const endAll = async (reason: string) => {
    if (!confirm || confirm.busy) return
    setConfirm({ busy: true, problem: null })
    try {
      const answer = await endUserSessions(api, userId, reason || undefined)
      setConfirm(null)
      setNotice({ key: 'person.done', tone: 'success', params: { count: answer.ended, name } })
      load()
    } catch (error) {
      setConfirm({ busy: false, problem: problemKey(error) })
    }
  }

  return (
    <UserSessionsTab
      model={{ prefix, name, self, read, confirm, notice }}
      actions={{
        onRetry: () => {
          setRead({ state: 'loading' })
          load()
        },
        onEndAll: () => setConfirm({ busy: false, problem: null }),
        onConfirm: (reason) => void endAll(reason),
        onCancel: () => setConfirm(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
