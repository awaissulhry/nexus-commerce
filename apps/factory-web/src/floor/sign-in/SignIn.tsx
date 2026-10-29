'use client'

import { useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { changePin, signIn, type Credentials } from '../api'
import { useFloor } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { newPinProblem } from '../model'
import { SignInView, type ChangeProblem, type SignInAction, type SignInProblem, type SignInStep } from './view/SignInView'

/**
 * The live SCR-021 (`/floor/sign-in`): the badge (or the name) and the PIN go to POST /floor/sign-in — or
 * /floor/switch when a badge was scanned on a signed-in tablet — and the app's gate sends the person on (the notice
 * when due, else Home). The PIN lives only in this component's memory: typed on the pad, sent, and kept for the
 * new-PIN step only (it is the "current PIN" of POST /floor/pin after an administrator's reset), then dropped.
 */

const problemOf = (problem: string): SignInProblem =>
  problem === 'rateLimited' || problem === 'operatorActive' || problem === 'pinNeeded' ? problem : problem === 'unavailable' ? 'unavailable' : 'wrong'

export function FloorSignIn() {
  const store = useFloor()
  const feedback = useConfirmFeedback()
  const { device, me } = store
  const switching = Boolean(me && store.pendingSwitch)
  const { frame, onFrame } = store.frame(switching ? 'signIn.switch.frameTitle' : 'signIn.title', { showHome: switching })
  const changing = Boolean(me?.pinMustChange)
  const [step, setStep] = useState<SignInStep>(() => (changing ? { kind: 'change', stage: 'current' } : switching ? { kind: 'pin', forName: null } : { kind: 'badge' }))
  const [problem, setProblem] = useState<SignInProblem | null>(null)
  const [changeProblem, setChangeProblem] = useState<ChangeProblem>(null)
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)
  const held = useRef<{ badgeCode?: string; workerId?: string; name?: string; pin?: string; newPin?: string }>({})

  // A sign-in that must choose a new PIN: the one just typed is the current one (with a badge alone, ask it).
  useEffect(() => {
    if (changing && step.kind !== 'change') setStep({ kind: 'change', stage: held.current.pin ? 'new' : 'current' })
  }, [changing, step.kind])

  const send = async (credentials: Credentials) => {
    setBusy(true)
    setProblem(null)
    const answer = await signIn(store.api, credentials, switching ? 'switch' : 'sign-in')
    setBusy(false)
    if (!answer.ok) {
      feedback('error')
      // A refused PIN keeps the pad (the same badge or name, a new try); a refused badge alone goes back to the scan.
      held.current.pin = undefined
      setProblem(problemOf(answer.problem))
      if (credentials.pin === undefined) {
        held.current = {}
        setStep({ kind: 'badge' })
      }
      return
    }
    feedback('success')
    if (!answer.value.pinMustChange) held.current = {}
    const from = me?.worker.displayName ?? null
    store.setMe(answer.value)
    // The app's gate sends the person on: the notice when due, else Home.
    if (switching && from) store.completeSwitch(from, answer.value.worker.displayName)
  }

  const onAction = async (action: SignInAction) => {
    switch (action.type) {
      case 'badge':
        held.current = { badgeCode: action.code }
        if (device?.signIn.badgeOnly) return send({ badgeCode: action.code })
        setProblem(null)
        return setStep({ kind: 'pin', forName: null })
      case 'names':
        setProblem(null)
        return setStep({ kind: 'names', letter: null })
      case 'letter':
        return setStep({ kind: 'names', letter: action.letter })
      case 'name': {
        const worker = device?.roster.find((entry) => entry.id === action.workerId)
        held.current = { workerId: action.workerId, name: worker?.displayName }
        setProblem(null)
        return setStep({ kind: 'pin', forName: worker?.displayName ?? null })
      }
      case 'pin': {
        const { badgeCode, workerId } = held.current
        if (switching && store.pendingSwitch) return send({ badgeCode: store.pendingSwitch, pin: action.pin })
        if (!badgeCode && !workerId) return setStep({ kind: 'badge' })
        held.current.pin = action.pin
        return send(badgeCode ? { badgeCode, pin: action.pin } : { workerId: workerId!, pin: action.pin })
      }
      case 'back':
        held.current = {}
        setProblem(null)
        if (switching) return store.cancelSwitch()
        return setStep({ kind: 'badge' })
      case 'forgot':
        return setForgot(action.open)
      case 'cancel-switch':
        return store.cancelSwitch()
      case 'change':
        return choosePin(action.pin)
    }
  }

  const choosePin = async (pin: string) => {
    if (step.kind !== 'change') return
    setChangeProblem(null)
    if (step.stage === 'current') {
      held.current.pin = pin
      return setStep({ kind: 'change', stage: 'new' })
    }
    if (step.stage === 'new') {
      const rule = newPinProblem(pin)
      if (rule === 'repeat' || rule === 'run') {
        feedback('warning')
        return setChangeProblem(rule)
      }
      held.current.newPin = pin
      return setStep({ kind: 'change', stage: 'repeat' })
    }
    if (pin !== held.current.newPin) {
      feedback('warning')
      held.current.newPin = undefined
      setChangeProblem('mismatch')
      return setStep({ kind: 'change', stage: 'new' })
    }
    setBusy(true)
    const answer = await changePin(store.api, held.current.pin ?? '', pin)
    setBusy(false)
    if (!answer.ok) {
      feedback('error')
      held.current.newPin = undefined
      if (answer.problem === 'pinRefused') {
        setChangeProblem('refused')
        return setStep({ kind: 'change', stage: 'new' })
      }
      // A wrong "current PIN" (the office's): start again from it.
      held.current.pin = undefined
      setChangeProblem('wrong')
      return setStep({ kind: 'change', stage: 'current' })
    }
    feedback('success')
    held.current = {}
    store.setMe(answer.value)
  }

  useFloorKeys({ escape: step.kind === 'pin' || step.kind === 'names' ? () => void onAction({ type: 'back' }) : null })

  return (
    <SignInView
      model={{
        frame,
        step,
        badgeOnly: Boolean(device?.signIn.badgeOnly),
        roster: (device?.roster ?? []).map((entry) => ({ id: entry.id, name: entry.displayName })),
        problem,
        changeProblem,
        busy,
        signedOut: store.signedOut,
        switchingFrom: switching ? (me?.worker.displayName ?? null) : null,
        forgotOpen: forgot,
      }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
    />
  )
}
