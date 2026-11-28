'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { departmentOfAnswer } from '../../lib/department/model'
import { newIdempotencyKey } from '../../lib/api/client'
import { useT } from '../../lib/i18n/provider'
import { mediaName } from '../basket/help/model'
import { measureVoice } from '../basket/help/media'
import { problemWords } from '../basket/help/view/HelpWindowView'
import { FloorFrameView } from '../frame/view/FloorFrameView'
import { useFloor, useFloorRouter } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { queuedView } from '../tasks/shared/queued'
import { TASK_ROUTES } from '../tasks/routes'
import { postSuggestion, readProfile, sendNamedSuggestion, uploadSuggestionVoice, type FloorProfile } from './api'
import { floorLanguages, mayQueueSuggestion, NEW_SUGGESTION, roleOf, savedHere, suggestionHeld, suggestionPayload, type SuggestionDraft } from './model'
import { setFloorSetting, useFloorDeviceSettings } from './settings'
import { MeView, type MeAction } from './view/MeView'
import { TellOfficeWindow, type TellAction, type TellStep } from './view/TellOfficeWindow'

/**
 * owb-fl8 step 4 — the live Floor › Me (`/floor/me`): reads GET /floor/me/profile once on opening (and when the network is back),
 * the language through the frame's own switch (the person's language for this session), Large words and Sound on this phone only,
 * My day (its own page, behind the PIN), My record (the queue's page: one tick on this phone, two at the office), Change person (sign
 * out: the next person signs in), and Tell the office (named: online first, else kept on the phone; without the name: online only).
 */

let keptProfile: FloorProfile | null = null

export function FloorMe() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-help2')
  const { frame, onFrame } = store.frame('tile.me', { showHome: true })
  const { api, me, online, locale, queue, queueSnapshot, sessionEnded } = store
  const settings = useFloorDeviceSettings()
  const [profile, setProfile] = useState<FloorProfile | null>(keptProfile)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(keptProfile ? 'ready' : 'loading')
  const [tellOpen, setTellOpen] = useState(false)
  const [draft, setDraft] = useState<SuggestionDraft>(NEW_SUGGESTION)
  const [tell, setTell] = useState<TellStep>({ kind: 'draft' })
  const [keptId, setKeptId] = useState<string | null>(null)
  const [voiceOpenedAt, setVoiceOpenedAt] = useState(0)

  const read = useCallback(async () => {
    const answer = await readProfile(api)
    if (answer.ok) {
      keptProfile = answer.value
      setProfile(answer.value)
      return setState('ready')
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    setState(keptProfile ? 'ready' : 'failed')
  }, [api, sessionEnded])

  useEffect(() => {
    if (me) void read()
  }, [me, online, read])

  // A named suggestion kept on the phone: its ticks.
  useEffect(() => {
    if (!keptId) return
    const view = queuedView(queueSnapshot, keptId)
    if (view) setTell((now) => (now.kind === 'sent' && now.ticks !== view.ticks ? { ...now, ticks: view.ticks } : now))
  }, [queueSnapshot, keptId])

  const departments = useMemo(() => (profile?.departments ?? []).map((row) => departmentOfAnswer(row, locale)), [profile, locale])

  const closeTell = () => {
    if (tell.kind === 'draft' && tell.busy) return
    setTellOpen(false)
    setTell({ kind: 'draft' })
    setDraft(NEW_SUGGESTION)
    setKeptId(null)
  }

  const sendTell = async (withName: boolean) => {
    if (tell.kind !== 'draft' || tell.busy || suggestionHeld(draft, online, withName)) return
    setTell({ kind: 'draft', busy: true, failed: null })
    let voiceFileId: string | null = null
    if (draft.voice) {
      const up = await uploadSuggestionVoice(api, draft.voice.blob, mediaName('suggestion', 'voice', new Date(), draft.voice.blob.type), draft.voice.seconds)
      if (!up.ok) {
        if (up.problem.kind === 'signedOut') return void sessionEnded()
        feedback('error')
        return setTell({ kind: 'draft', failed: problemWords(t, up.problem) })
      }
      voiceFileId = up.value.fileId
    }
    const payload = suggestionPayload(draft, withName, voiceFileId)
    if (mayQueueSuggestion(withName)) {
      const result = await sendNamedSuggestion(api, queue, online, payload)
      if (result.kept) {
        feedback('success')
        setKeptId(result.kept.clientEventId)
        return setTell({ kind: 'sent', ticks: 'saved' })
      }
      if (!result.answer.ok) {
        if (result.answer.problem.kind === 'signedOut') return void sessionEnded()
        feedback('error')
        return setTell({ kind: 'draft', failed: problemWords(t, result.answer.problem) })
      }
    } else {
      // Without the name: one try, online only; it never waits on the phone (the queue keeps who and which phone).
      const answer = await postSuggestion(api, payload, newIdempotencyKey())
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') return void sessionEnded()
        feedback('error')
        return setTell({ kind: 'draft', failed: answer.problem.kind === 'offline' ? t('tell.held.anonOffline') : problemWords(t, answer.problem) })
      }
    }
    feedback('success')
    setDraft(NEW_SUGGESTION)
    setTell({ kind: 'sent', ticks: null })
  }

  const onTell = (action: TellAction) => {
    switch (action.type) {
      case 'kind':
        return setDraft((now) => ({ ...now, kind: action.kind }))
      case 'words':
        return setDraft((now) => ({ ...now, words: action.text }))
      case 'record':
        if (!online) return
        setVoiceOpenedAt(Date.now())
        return setTell({ kind: 'draft', recording: true })
      case 'voice':
        return void measureVoice(action.blob, voiceOpenedAt).then((seconds) => {
          setDraft((now) => ({ ...now, voice: { blob: action.blob, seconds } }))
          setTell({ kind: 'draft' })
        })
      case 'cancelVoice':
        return setTell({ kind: 'draft' })
      case 'dropVoice':
        return setDraft((now) => ({ ...now, voice: null }))
      case 'send':
        return void sendTell(action.withName)
      case 'close':
        return closeTell()
    }
  }

  const onAction = (action: MeAction) => {
    switch (action.type) {
      case 'myday':
        return router.push(TASK_ROUTES.myday)
      case 'tell':
        return setTellOpen(true)
      case 'large':
        return void setFloorSetting('large', !settings.large)
      case 'sound':
        return void setFloorSetting('sound', !settings.sound)
      case 'record':
        return router.push('/floor/sync')
      case 'person':
        return onFrame({ type: 'sign-out' })
      case 'language':
        return onFrame({ type: 'locale', locale: action.locale })
      case 'retry':
        setState('loading')
        return void read()
    }
  }

  useFloorKeys({ escape: () => (tellOpen ? closeTell() : router.push('/floor')) })

  if (!me) return null
  return (
    <FloorFrameView frame={frame} onFrame={onFrame}>
      <MeView
        model={{
          name: me.worker.displayName,
          role: roleOf(me.permissions),
          profile,
          state,
          departments,
          locale,
          languages: floorLanguages(profile?.floorLocales ?? []),
          settings,
          online,
          waiting: savedHere(queueSnapshot.items, me.worker.id),
        }}
        onAction={onAction}
      />
      <TellOfficeWindow open={tellOpen} step={tell} draft={draft} online={online} onAction={onTell} />
    </FloorFrameView>
  )
}
