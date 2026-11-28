'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useDepartments } from '../../../lib/department/use-departments'
import { INTL_LOCALE } from '../../../lib/i18n/locales'
import { useFloor } from '../../FloorApp'
import { queuedView } from '../../tasks/shared/queued'
import { pickDepartment, raiseCall, raisePayload, readCallTypes, uploadCallFile, type CallGroup, type CallTypes, type HelpRead } from './api'
import { measureVoice } from './media'
import { ASK_CODES, mediaName, needsDepartment, pickOutcome, PROBLEM_CODES, raiseOutcome, tilesOf, VOICE_ASK } from './model'
import { HelpWindowView, type WindowAction, type WindowStep } from './view/HelpWindowView'

/**
 * owb-fl8 step 1 + 2 — the container of the Problem window and the Ask window: reads the site's types of the group when it opens,
 * offers the department pick when the phone has none (settle 3), tells the call with ONE tap online first (else saved on this
 * phone, the same action under the same id: `andon.call.send`), and after "Something else (voice)" puts the voice note on the new
 * call. A told call closes the window: the red card (or the ask card) on the basket is the answer, once the basket is read again.
 */

export interface HelpWindowProps {
  readonly group: CallGroup
  readonly open: boolean
  readonly onClose: () => void
  readonly read: HelpRead
  /** Read the basket again (a call was told or the department picked). */
  readonly onChanged?: () => void
}

/** The kept types per group for this visit: a window that opens again draws at once, and offline too. */
const KEPT: Partial<Record<CallGroup, CallTypes>> = {}

export function HelpWindow({ group, open, onClose, read, onChanged }: HelpWindowProps) {
  const { api, queue, queueSnapshot, online, me, locale, sessionEnded } = useFloor()
  const feedback = useConfirmFeedback()
  const { departments } = useDepartments(api)
  const [types, setTypes] = useState<CallTypes | null>(KEPT[group] ?? null)
  const [step, setStep] = useState<WindowStep>({ kind: 'loading' })
  const [pickedHere, setPickedHere] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const voiceOpenedAt = useRef(0)
  const codes: readonly string[] = group === 'ASK' ? ASK_CODES : PROBLEM_CODES
  /** The saved call the basket was read again for (once per call, whatever the host's onChanged is). */
  const reReadFor = useRef<string | null>(null)

  const loadTypes = useCallback(async () => {
    const answer = await readCallTypes(api, group)
    if (answer.ok) {
      KEPT[group] = answer.value
      setTypes(answer.value)
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    if (!KEPT[group]) setStep({ kind: 'problem', problem: answer.problem })
  }, [api, group, sessionEnded])

  // On opening: the department first when the phone has none, else the tiles (as soon as the types are there).
  useEffect(() => {
    if (!open) return
    setSavedId(null)
    setStep(needsDepartment(read, pickedHere) ? { kind: 'department' } : { kind: KEPT[group] ? 'tiles' : 'loading' })
    void loadTypes()
  }, [open]) // only when the window opens

  useEffect(() => {
    if (types && step.kind === 'loading') setStep({ kind: 'tiles' })
  }, [types, step.kind])

  // A saved call's ticks (saved on this phone → recorded by the office).
  useEffect(() => {
    if (!savedId) return
    const view = queuedView(queueSnapshot, savedId)
    if (!view) return
    setStep((now) => (now.kind === 'saved' && now.ticks !== view.ticks ? { ...now, ticks: view.ticks } : now))
    if (view.ticks !== 'recorded' || reReadFor.current === savedId) return
    reReadFor.current = savedId
    onChanged?.()
  }, [queueSnapshot, savedId, onChanged])

  const close = () => {
    setStep({ kind: 'loading' })
    onClose()
  }

  const pick = async (departmentId: string, stationId?: string) => {
    setStep((now) => (now.kind === 'department' || now.kind === 'station' ? { ...now, busy: true, problem: null } : now))
    const answer = await pickDepartment(api, departmentId, stationId)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setStep((now) => (now.kind === 'department' || now.kind === 'station' ? { ...now, busy: false, problem: answer.problem } : { kind: 'department', problem: answer.problem }))
    }
    const outcome = pickOutcome(answer.value)
    if (outcome.kind === 'choose') return setStep({ kind: 'station', departmentId, stations: outcome.stations })
    if (outcome.kind === 'none') return setStep({ kind: 'noStation' })
    feedback('success')
    setPickedHere(true)
    onChanged?.()
    setStep({ kind: types ? 'tiles' : 'loading' })
  }

  const raise = async (code: string, typeId: string, voice?: { readonly blob: Blob; readonly seconds: number }) => {
    setStep({ kind: 'sending' })
    const result = await raiseCall(api, queue, online, raisePayload(typeId, read))
    const outcome = raiseOutcome(result, read.basket.id)
    switch (outcome.kind) {
      case 'told': {
        if (voice) {
          const sent = await uploadCallFile(api, outcome.callId, voice.blob, mediaName(read.basket.code, 'voice', new Date(), voice.blob.type), voice.seconds)
          if (!sent.ok) {
            feedback('error')
            onChanged?.()
            return setStep({ kind: 'problem', problem: sent.problem, afterVoice: true })
          }
        }
        feedback('success')
        onChanged?.()
        return close()
      }
      case 'already':
        feedback('success')
        return setStep({ kind: 'already', basketCode: outcome.basketCode })
      case 'department':
        setPickedHere(false)
        return setStep({ kind: 'department' })
      case 'saved':
        feedback('success')
        setSavedId(outcome.clientEventId)
        return setStep({ kind: 'saved', code, ticks: 'saved', voiceLost: Boolean(voice) })
      case 'problem':
        if (outcome.problem.kind === 'signedOut') return void sessionEnded()
        feedback('error')
        return setStep({ kind: 'problem', problem: outcome.problem })
    }
  }

  const voiceTypeId = useRef<string | null>(null)

  const onAction = (action: WindowAction) => {
    switch (action.type) {
      case 'department':
        return void pick(action.id)
      case 'station':
        return step.kind === 'station' ? void pick(step.departmentId, action.id) : undefined
      case 'tile':
        if (action.code === VOICE_ASK) {
          voiceTypeId.current = action.typeId
          voiceOpenedAt.current = Date.now()
          return setStep({ kind: 'voice', typeId: action.typeId })
        }
        return void raise(action.code, action.typeId)
      case 'voice': {
        const typeId = voiceTypeId.current
        if (!typeId) return
        return void measureVoice(action.blob, voiceOpenedAt.current).then((seconds) => raise(VOICE_ASK, typeId, { blob: action.blob, seconds }))
      }
      case 'again':
        if (!types) void loadTypes()
        return setStep(needsDepartment(read, pickedHere) ? { kind: 'department' } : { kind: types ? 'tiles' : 'loading' })
      case 'close':
        return close()
    }
  }

  return (
    <HelpWindowView
      model={{
        group,
        open,
        step,
        basket: { code: read.basket.code, picture: read.picture?.src ?? null },
        tiles: tilesOf(types?.types ?? [], codes),
        none: types?.none ?? null,
        departments,
        online,
        speech: me?.speech?.lang ?? INTL_LOCALE[locale],
      }}
      onAction={onAction}
    />
  )
}
