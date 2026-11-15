'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { Loaded } from '../model'
import { fetchFollowedViews, unpinView, viewsProblem } from './api'
import { chipsOf, type MyViewsModel, type ViewChip } from './model'
import { MyViewsView } from './view/MyViewsView'

/** How often the counts are read again while Today stays open (the scheduler counts every 15 minutes). */
const READ_AGAIN_MS = 5 * 60_000

/**
 * Today › My saved views, the container (B-W2b-388): reads my pinned views (GET /notifications/following/views) when Today opens,
 * every 5 minutes after and when a followed view changed (`notification.created`: B-W2b-385 tells me), opens a chip's list with
 * the view, and unpins one (DELETE …/:viewId). Today mounts it in its section list.
 */
export function MyViews() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [views, setViews] = useState<Loaded<readonly ViewChip[]>>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<MyViewsModel['notice']>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const answer = await fetchFollowedViews(api)
      setViews({ status: 'ready', data: chipsOf(answer, prefix, OFFICE_PAGES) })
      setNow(Date.now())
    } catch (error) {
      setViews({ status: 'error', problem: viewsProblem(error) })
    }
  }, [api, prefix])
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), READ_AGAIN_MS)
    return () => clearInterval(timer)
  }, [load])
  const live = useLiveBus({ onChange: (change) => change.type === 'notification.created' && void load(), onReconnect: () => void load() })

  const model = useMemo<MyViewsModel>(() => ({ views, now, held: live === 'offline' ? 'held.offline' : busy ? 'held.busy' : null, notice }), [views, now, live, busy, notice])
  return (
    <MyViewsView
      model={model}
      actions={{
        onOpen: (chip) => chip.href && router.push(chip.href),
        onUnpin: (chip) => {
          setBusy(true)
          unpinView(api, chip.viewId)
            .then((answer) => {
              setViews({ status: 'ready', data: chipsOf(answer, prefix, OFFICE_PAGES) })
              setNotice({ key: 'views.unpinned', tone: 'success', params: { name: chip.name } })
            })
            .catch((error: unknown) => setNotice({ key: viewsProblem(error), tone: 'danger' }))
            .finally(() => setBusy(false))
        },
        onRetry: () => void load(),
      }}
    />
  )
}
