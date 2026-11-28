'use client'

import { useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import { useFloor } from '../../FloorApp'
import { queuedView } from '../../tasks/shared/queued'
import type { TickState } from '../../tasks/shared/view/TaskParts'
import { answerCall, setCallSpot, uploadCallFile, type AnswerStep, type CallFlag, type HelpRead } from './api'
import { measureVoice } from './media'
import { answersCalls, mediaName } from './model'
import { problemWords } from './view/HelpWindowView'
import { MediaWindow } from './view/MediaWindow'
import { ProblemCardView, type CardAction } from './view/ProblemCardView'
import { SpotWindow } from './view/SpotWindow'

/**
 * owb-fl8 step 1 — the container of the red card: the leader's On my way / Solved and the worker's Solved go through the phone's
 * queue (`andon.call.answer`: they work with no network, the two ticks follow them); a photo, a voice note and the place go up
 * online onto the call. After each, the basket is read again (`onChanged`), once.
 */

export interface CardProps {
  readonly read: HelpRead
  readonly onChanged?: () => void
}

/** The answer saved on this phone, until the office recorded it. */
export function usePendingAnswer(onChanged: (() => void) | undefined) {
  const { queue, queueSnapshot } = useFloor()
  const feedback = useConfirmFeedback()
  const [pending, setPending] = useState<{ readonly step: AnswerStep; readonly clientEventId: string; readonly ticks: TickState } | null>(null)
  const reReadFor = useRef<string | null>(null)
  useEffect(() => {
    if (!pending) return
    const view = queuedView(queueSnapshot, pending.clientEventId)
    if (!view) return
    if (view.ticks !== pending.ticks) setPending({ ...pending, ticks: view.ticks })
    if ((view.ticks === 'recorded' || view.ticks === 'refused') && reReadFor.current !== pending.clientEventId) {
      reReadFor.current = pending.clientEventId
      onChanged?.()
      if (view.ticks === 'recorded') setPending(null)
    }
  }, [queueSnapshot, pending, onChanged])
  const answer = async (callId: string, step: AnswerStep) => {
    try {
      const item = await answerCall(queue, callId, step)
      feedback('success')
      setPending({ step, clientEventId: item.clientEventId, ticks: 'saved' })
    } catch {
      feedback('error')
    }
  }
  return { pending, answer }
}

export function ProblemCard({ read, onChanged }: CardProps) {
  const flag = read.flags.problem
  return flag ? <OpenProblemCard read={read} flag={flag} onChanged={onChanged} /> : null
}

function OpenProblemCard({ read, flag, onChanged }: CardProps & { readonly flag: CallFlag }) {
  const { api, online, me, sessionEnded } = useFloor()
  const t = useT('floor-help2')
  const feedback = useConfirmFeedback()
  const { pending, answer } = usePendingAnswer(onChanged)
  const [media, setMedia] = useState<'PHOTO' | 'AUDIO' | null>(null)
  const [spotOpen, setSpotOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [sent, setSent] = useState<'photo' | 'voice' | 'spot' | null>(null)

  // "Sent to the office" stands a short while, then the card is quiet again.
  useEffect(() => {
    if (!sent) return
    const timer = window.setTimeout(() => setSent(null), 6_000)
    return () => window.clearTimeout(timer)
  }, [sent])

  const closeMedia = () => {
    if (busy) return
    setMedia(null)
    setSpotOpen(false)
    setFailed(null)
  }

  const upload = async (blob: Blob, kind: 'photo' | 'voice', seconds?: number) => {
    setBusy(true)
    setFailed(null)
    const answer = await uploadCallFile(api, flag.callId, blob, mediaName(read.basket.code, kind, new Date(), blob.type), seconds)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setFailed(problemWords(t, answer.problem))
    }
    feedback('success')
    setMedia(null)
    setSent(kind)
    onChanged?.()
  }

  const pickSpot = async (spot: number) => {
    setBusy(true)
    setFailed(null)
    const answer = await setCallSpot(api, flag.callId, spot)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setFailed(problemWords(t, answer.problem))
    }
    feedback('success')
    setSpotOpen(false)
    setSent('spot')
    onChanged?.()
  }

  const onAction = (action: CardAction) => {
    switch (action.type) {
      case 'photo':
        return online ? setMedia('PHOTO') : undefined
      case 'voice':
        return online ? setMedia('AUDIO') : undefined
      case 'spot':
        return online ? setSpotOpen(true) : undefined
      case 'answer':
        return void answer(flag.callId, action.step)
    }
  }

  return (
    <>
      <ProblemCardView
        model={{ flag, picture: read.picture?.src ?? null, online, answers: answersCalls(me?.permissions ?? []), pending: pending ? { step: pending.step, ticks: pending.ticks } : null, sent }}
        onAction={onAction}
      />
      <MediaWindow
        open={media ? { kind: media, title: t(media === 'PHOTO' ? 'card.photoTitle' : 'card.voiceTitle', { code: read.basket.code }) } : null}
        busy={busy}
        failed={failed}
        onPhoto={(blob) => void upload(blob, 'photo')}
        onVoice={(blob, openedAt) => void measureVoice(blob, openedAt).then((seconds) => upload(blob, 'voice', seconds))}
        onClose={closeMedia}
      />
      <SpotWindow open={spotOpen} basketCode={read.basket.code} picture={read.picture?.src ?? null} value={typeof flag.spot === 'number' ? flag.spot : null} busy={busy} failed={failed} onPick={(spot) => void pickSpot(spot)} onClose={closeMedia} />
    </>
  )
}
