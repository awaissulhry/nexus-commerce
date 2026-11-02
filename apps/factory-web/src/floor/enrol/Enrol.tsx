'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { kioskCheck, type KioskHomeTest } from '@nexus/factory-domain/auth/floor/kiosk'
import { localeOf } from '../../lib/i18n/locales'
import { enrolDevice, reportKioskCheck, type DeviceInfo } from '../api'
import { zxingCamera } from '../camera'
import { useFloor } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { enrolmentCodeOf, modeOf } from '../model'
import { EnrolView, type Binding, type Checks, type EnrolAction, type EnrolStep, type InstallState, type KioskCheckView } from './view/EnrolView'

/**
 * The live SCR-020 (`/floor/enrol`, also `/floor/enrol#token=…` from the office's QR code opened by the tablet's
 * camera app): the set-up code is read from the scan (or the address's fragment, once, then removed from the address
 * bar) and traded for the device token; the binding, the install and the checks follow. The code never enters the
 * view's model, a log or the address bar. B-W2b-67: the mode comes from the office's enrol wizard; the kiosk step reports
 * its honest check (POST /floor/device/kiosk: full screen, installed, what the person said) to the device's history.
 */

export function bindingOf(device: DeviceInfo): Binding {
  return {
    device: device.device.name,
    site: device.site.name,
    station: device.device.station ? `${device.device.station.code} · ${device.device.station.name}` : null,
    mode: modeOf(device.device.station),
    language: localeOf(device.defaultLocale) ?? 'it',
    deviceMode: device.device.mode ?? 'STATION',
    line: device.line ? `${device.line.code} · ${device.line.name}` : null,
    kiosk: device.rules?.kiosk ?? true,
  }
}

const standalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true)

/** What the browser can tell of itself (null: it does not say). An installed app runs full screen; a browser tab says nothing of an install. */
function tabletFacts(installable: boolean): { fullScreen: boolean | null; installed: boolean | null } {
  if (typeof window === 'undefined' || !window.matchMedia) return { fullScreen: null, installed: null }
  const app = standalone()
  return { fullScreen: app || window.matchMedia('(display-mode: fullscreen)').matches, installed: app ? true : installable ? false : null }
}

export function FloorEnrol() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('enrol.title')
  const [step, setStep] = useState<EnrolStep>(() =>
    store.device ? { kind: 'replace', current: { device: store.device.device.name, station: store.device.device.station?.name ?? null, site: store.device.site.name } } : { kind: 'scan' },
  )
  const [storage, setStorage] = useState<InstallState['storage']>('unknown')
  const [checks, setChecks] = useState<Checks>({ camera: 'missing', scanner: 'waiting', sound: 'untested', vibration: 'missing' })
  const [homeTest, setHomeTest] = useState<KioskHomeTest>('NOT_TESTED')
  const [kioskRows, setKioskRows] = useState<KioskCheckView['rows'] | null>(null)
  const read = useRef(false)
  const enrolled = useRef<DeviceInfo | null>(null)

  const trade = useCallback(
    async (raw: string) => {
      const code = enrolmentCodeOf(raw)
      if (!navigator.onLine) return setStep({ kind: 'scan', problem: 'offline' })
      if (!code) {
        feedback('error')
        return setStep({ kind: 'scan', problem: 'codeInvalid' })
      }
      setStep({ kind: 'scan', busy: true })
      const answer = await enrolDevice(store.api, code, store.appUpdate.running)
      if (!answer.ok) {
        feedback('error')
        const problem = answer.problem === 'rateLimited' ? 'rateLimited' : answer.problem === 'unavailable' ? 'unavailable' : 'codeInvalid'
        return setStep({ kind: 'scan', problem })
      }
      feedback('success')
      enrolled.current = answer.value
      setStep({ kind: 'binding', binding: bindingOf(answer.value) })
    },
    [feedback, store.api, store.appUpdate.running],
  )

  // The office's QR code opened as a link: its code is in the fragment, read once.
  useEffect(() => {
    if (read.current) return
    read.current = true
    const hash = window.location.hash
    if (!hash) return
    window.history.replaceState(window.history.state, '', window.location.pathname)
    void trade(`#${hash.slice(1)}`)
  }, [trade])

  // What the tablet can do (the install step's checks): asked once, on this step.
  useEffect(() => {
    if (step.kind !== 'install') return
    setChecks((current) => ({
      ...current,
      camera: typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'ok' : 'missing',
      vibration: typeof navigator.vibrate === 'function' ? 'ok' : 'missing',
    }))
    void navigator.storage?.persisted?.().then((kept) => kept && setStorage('kept'))
  }, [step.kind])

  // On the install step any scan proves the scanner (a wedge burst reaches the document's keys).
  useEffect(() => {
    if (step.kind !== 'install') return
    let burst = 0
    let last = 0
    const onKey = (event: KeyboardEvent) => {
      const now = event.timeStamp
      burst = now - last < 40 ? burst + 1 : 1
      last = now
      if (burst >= 6) setChecks((current) => (current.scanner === 'ok' ? current : { ...current, scanner: 'ok' }))
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [step.kind])

  const binding = enrolled.current ? bindingOf(enrolled.current) : store.device ? bindingOf(store.device) : null
  const install: InstallState = { app: standalone() ? 'installed' : store.installPrompt ? 'available' : 'manual', storage }
  const facts = tabletFacts(Boolean(store.installPrompt))
  const kioskView: KioskCheckView = { rows: kioskRows ?? kioskCheck({ ...facts, homeTest }).rows, homeTest }

  /** The check as it stands goes on the device's history; a failure blocks nothing (the guide is a help, never a gate). */
  const report = async (result: KioskHomeTest) => {
    const answer = await reportKioskCheck(store.api, { ...facts, homeTest: result })
    if (answer.ok) setKioskRows(answer.value.rows)
  }

  const onAction = async (action: EnrolAction) => {
    switch (action.type) {
      case 'code':
        return trade(action.code)
      case 'retry':
        return setStep({ kind: 'scan' })
      case 'keep':
        return router.replace('/floor')
      case 'replace':
        return setStep({ kind: 'scan' })
      case 'continue':
        if (!binding) return
        if (step.kind === 'binding') return setStep({ kind: 'install', binding, install, checks })
        if (step.kind === 'install' && binding.kiosk) return setStep({ kind: 'kiosk', binding, check: kioskView })
        if (step.kind === 'kiosk') void report(homeTest)
        return setStep({ kind: 'done', binding })
      case 'home-test':
        setHomeTest(action.result)
        setKioskRows(null)
        return report(action.result)
      case 'install':
        if (!store.installPrompt) return
        await store.installPrompt.prompt()
        return
      case 'keep-data': {
        const kept = (await navigator.storage?.persist?.()) ?? false
        return setStorage(kept ? 'kept' : 'notKept')
      }
      case 'test-sound':
        feedback('success')
        return setChecks((current) => ({ ...current, sound: 'ok' }))
      case 'sign-in':
        // The device is enrolled now: the app reads it again and goes to sign-in.
        if (enrolled.current) store.setDevice(enrolled.current)
        await store.reload()
        return router.replace('/floor/sign-in')
    }
  }

  useFloorKeys({
    enter: step.kind === 'binding' || step.kind === 'install' || step.kind === 'kiosk' ? () => void onAction({ type: 'continue' }) : step.kind === 'done' ? () => void onAction({ type: 'sign-in' }) : step.kind === 'replace' ? () => void onAction({ type: 'keep' }) : null,
    escape:
      step.kind === 'install' && binding
        ? () => setStep({ kind: 'binding', binding })
        : step.kind === 'kiosk' && binding
          ? () => setStep({ kind: 'install', binding, install, checks })
          : step.kind === 'scan' && step.problem
            ? () => setStep({ kind: 'scan' })
            : null,
  })

  const shown: EnrolStep = step.kind === 'install' ? { ...step, install, checks } : step.kind === 'kiosk' ? { ...step, check: kioskView } : step
  return <EnrolView model={{ step: shown, frame }} onFrame={onFrame} onAction={(action) => void onAction(action)} camera={zxingCamera} />
}
