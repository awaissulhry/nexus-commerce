'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { addDevice, fetchPush, pushProblem, removeDevice, testPush } from './api'
import { currentSubscription, storedDevice, storeDevice, subscribe, unsubscribe } from './browser'
import { browserFacts, browserPush, deviceLabel, pushSteps, turnOnHeld, type PushDevice, type PushModel, type PushState, type PushStep } from './model'
import { PushDialog } from './view/PushDialog'

/**
 * Get urgent items on this phone, the container (B-W2b-388): reads my push state (GET /notifications/push) and what this browser
 * can do, finds this browser's device (its stored id while its subscription lives), turns push on (the browser's permission and
 * subscription → POST /notifications/push/devices, its keys sealed by the API), sends a test push, and turns a device off
 * (DELETE …/devices/:id; this browser's subscription stops too). Home › Notifications opens it from its band ⋯.
 */
export function Push({ onClose, onPreferences }: { onClose: () => void; onPreferences?: () => void }) {
  const api = useOfficeApi()
  const [push, setPush] = useState<PushModel['push']>({ status: 'loading' })
  const [browser] = useState(() => browserPush(browserFacts()))
  const [thisDevice, setThisDevice] = useState<string | null>(null)
  const [step, setStep] = useState<PushStep>('urgent')
  const [label, setLabel] = useState(() => (typeof navigator === 'undefined' ? '' : deviceLabel(navigator.userAgent)))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<PushModel['notice']>(null)
  const [tested, setTested] = useState<PushModel['tested']>({})
  const live = useLiveBus({})
  const offline = live === 'offline'

  const known = useCallback(async (state: PushState) => {
    const stored = storedDevice()
    const subscription = await currentSubscription().catch(() => null)
    const mine = stored && subscription && state.devices.some((device) => device.id === stored) ? stored : null
    if (!mine && stored) storeDevice(null)
    setThisDevice(mine)
  }, [])
  const load = useCallback(async () => {
    try {
      const state = await fetchPush(api)
      setPush({ status: 'ready', data: state })
      await known(state)
    } catch (error) {
      setPush({ status: 'error', problem: pushProblem(error) })
    }
  }, [api, known])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setNotice(null)
    try {
      await work()
    } catch (error) {
      setNotice({ key: pushProblem(error), tone: 'warning', params: { count: push.status === 'ready' ? push.data.maxDevices : 10 } })
    } finally {
      setBusy(false)
    }
  }
  const state = push.status === 'ready' ? push.data : null

  const model = useMemo<PushModel>(() => ({ push, browser, thisDevice, step: pushSteps(browser).includes(step) ? step : 'urgent', label, busy, offline, notice, tested }), [push, browser, thisDevice, step, label, busy, offline, notice, tested])
  return (
    <PushDialog
      model={model}
      actions={{
        onStep: setStep,
        onLabel: setLabel,
        onTurnOn: () => {
          if (!state?.publicKey || turnOnHeld({ push: state, browser, busy, offline, label, thisDevice: thisDevice !== null }) !== null) return
          const key = state.publicKey
          void run(async () => {
            const subscription = await subscribe(key)
            const answer = await addDevice(api, { label: label.trim(), ...subscription })
            storeDevice(answer.deviceId)
            setThisDevice(answer.deviceId)
            setPush({ status: 'ready', data: answer })
            setNotice({ key: 'push.notice.on', tone: 'success' })
            setStep('test')
          })
        },
        onTurnOff: (device: PushDevice) =>
          void run(async () => {
            const answer = await removeDevice(api, device.id)
            if (device.id === thisDevice) {
              await unsubscribe().catch(() => undefined)
              storeDevice(null)
              setThisDevice(null)
            }
            setPush({ status: 'ready', data: answer })
            setNotice({ key: 'push.notice.off', tone: 'success', params: { name: device.label } })
          }),
        onTest: () =>
          void run(async () => {
            const answer = await testPush(api, null)
            setPush({ status: 'ready', data: answer })
            setTested(Object.fromEntries(answer.results.map((result) => [result.deviceId, result.outcome])))
            const sent = answer.results.filter((result) => result.outcome === 'SENT').length
            setNotice(sent > 0 ? { key: 'push.notice.tested', tone: 'success', params: { count: sent } } : { key: 'push.notice.testFailed', tone: 'warning' })
          }),
        onRetry: () => void load(),
        ...(onPreferences ? { onPreferences } : {}),
        onClose,
      }}
    />
  )
}
