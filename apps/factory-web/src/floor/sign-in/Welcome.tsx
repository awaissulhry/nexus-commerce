'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useFloor } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { fetchOpenWork, newClockEventId } from '../tasks/clock/api'
import { TASK_ROUTES } from '../tasks/routes'
import { floorWrite } from '../tasks/shared/task-api'
import { WelcomeView } from './view/WelcomeView'
import { fetchNewHandover, welcomeCards, type WelcomeCard } from './arrival'

/**
 * The welcome cards after a sign-in (arrival.ts): each with one main action. Continue resumes the bundle a clock-out paused
 * (POST /production/terminal/resume) and opens it on Operation; offline the resume goes through the tablet's queue. A refusal
 * says so and goes on to Home; nothing here blocks a worker.
 */
export function FloorWelcome() {
  const store = useFloor()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('signIn.welcome.frameTitle')
  const { api, me, queue } = store
  const [cards, setCards] = useState<readonly WelcomeCard[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState(false)
  const asked = useRef(false)

  useEffect(() => {
    if (asked.current) return
    asked.current = true
    const held = me?.permissions ?? []
    void Promise.all([held.includes('floor.work') ? fetchNewHandover(api) : null, held.includes('production.scan') ? fetchOpenWork(api) : null]).then(([news, open]) => {
      const found = welcomeCards(news?.ok ? news.value : null, open?.ok ? open.value : null)
      setCards(found)
      if (found.length === 0) store.arrived()
    })
  }, [])

  const next = () => {
    setRefused(false)
    const rest = (cards ?? []).slice(1)
    setCards(rest)
    if (rest.length === 0) store.arrived()
  }

  const resume = async () => {
    const card = cards?.[0]
    if (card?.kind !== 'continue' || busy) return
    const { item } = card
    setBusy(true)
    const clientScanId = newClockEventId()
    const body = { bundleId: item.bundleId, workOrderOperationId: item.operation.id, clientScanId }
    const answer = await floorWrite(api, 'POST', '/production/terminal/resume', { body, schema: z.object({ timing: z.object({ state: z.string() }) }), idempotencyKey: clientScanId })
    if (!answer.ok && answer.problem.kind === 'offline') await queue.enqueue('production.scan.resume', { bundleId: item.bundleId, workOrderOperationId: item.operation.id })
    setBusy(false)
    if (!answer.ok && answer.problem.kind !== 'offline') {
      feedback('error')
      return setRefused(true)
    }
    feedback('success')
    store.arrived({ path: TASK_ROUTES.operation, code: item.bundleCode })
  }

  const card = cards?.[0] ?? null
  useFloorKeys({ enter: card?.kind === 'handover' || refused ? next : card?.kind === 'continue' ? () => void resume() : null })

  return <WelcomeView model={{ frame, card, busy, refused }} onFrame={onFrame} onAction={(action) => (action === 'continue' ? void resume() : next())} />
}
