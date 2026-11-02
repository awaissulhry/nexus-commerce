'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { CircleAlert, RotateCcw, Smartphone } from 'lucide-react'
import { FloorActionBar, useIdleSignOut } from '@nexus/ui/floor'
import type { ApiClient } from '../lib/api/client'
import { browserApi } from '../lib/api/browser'
import { readCookie, writeCookie } from '../lib/cookies'
import { LOCALE_COOKIE, isLocale, type Locale } from '../lib/i18n/locales'
import type { LocaleMessages } from '../lib/i18n/messages'
import { I18nProvider, useT } from '../lib/i18n/provider'
import { endCrew, fetchDevice, fetchMe, leaveCrew, signIn, signOut as apiSignOut, type CrewView, type DeviceInfo, type FloorMe, type FloorProblem } from './api'
import { FloorFrameView, type FrameAction, type FrameModel } from './frame/view/FloorFrameView'
import { FloorState } from './frame/view/FloorState'
import { floorLocale, IDLE_WARN_MS, idleWarnAfterMs } from './model'
import { numberKindsOf } from './queue/actions'
import { FloorQueue, type QueueSnapshot } from './queue/queue'
import { browserStorage } from './queue/storage'
import { DeviceReporter, readBattery, readNetwork, sendDeviceState } from './queue/report'
import { AppUpdater, queuedCount, updateStep, VERSION_CHECK_MS, type UpdateSnapshot, type UpdateStep } from './queue/update'
import { shellQueueOf, type ShellQueue } from './shell/banner'
import { keptSender } from './tasks/clock/api'
import { browserKeptStorage, KeptClocks, type KeptSnapshot } from './tasks/clock/kept'
import type { SignedOutWhy } from './sign-in/view/SignInView'
import { DEFAULT_TIME_ZONE } from '../lib/i18n/format'

/**
 * The floor app (SCR-020 … 025): one client root under `/floor` that knows the device and the signed-in operator,
 * speaks their language, keeps the frame's pop-ups and the idle sign-out, and sends each screen where it belongs:
 *
 *   no device token            → /floor/enrol      (SCR-020)
 *   enrolled, nobody signed in → /floor/sign-in    (SCR-021)
 *   a PIN to choose            → /floor/sign-in    (the new-PIN step)
 *   just signed in             → /floor/notice     when the worker notice is due (SCR-025), then what must come first on
 *                                                  sign-in's welcome cards (B-W2b-67: the handover note, Continue bundle), else /floor (SCR-022)
 * B-W2b-67: `/floor/clock` stays open with nobody signed in (a kiosk: a badge clocks, SCR-170); a crew's Add a person and a
 * chip open sign-in on a signed-in tablet (`crewStep`).
 * `/floor/enrol` stays open on an enrolled tablet (it asks "Replace?" first). A 401 from any call means the session
 * ended (idle, shift end, the office revoked it): the app reads the device again and shows sign-in with the reason.
 *
 * The offline queue (B-W0-30, queue/queue.ts) lives here too, for every screen: actions saved on the tablet first and
 * sent in order when the network is there (back online, back in view, after each action, on a timer), the banner's
 * counts (shell/banner.ts), and the tablet's label numbers topped up with each send.
 *
 * Safe app updates (B-W2a-42, PLT-241; queue/update.ts): the app knows the version its page runs, asks the server for
 * its current one, and takes a newer one only with the queue empty, the network there and a screen at rest. The tablet
 * tells the office its app version, battery and queue count (queue/report.ts; Admin › Devices).
 */

export interface FloorStore {
  api: ApiClient
  device: DeviceInfo | null
  me: FloorMe | null
  locale: Locale
  online: boolean
  /** Re-read the device and the operator (after a 401, an enrolment, a sign-in). */
  reload: () => Promise<void>
  setDevice: (device: DeviceInfo) => void
  setMe: (me: FloorMe | null, why?: SignedOutWhy) => void
  signOut: (why: Exclude<SignedOutWhy, null>) => Promise<void>
  /** Why the last operator left (the sign-in screen says it once). */
  signedOut: SignedOutWhy
  /** A code scanned on Home (or on Scan anything), for the screen it opens to take. */
  takeScan: () => string | null
  openScan: (code: string) => void
  /** Opens a floor task's page with a scanned code for it to take (Home's scan router). */
  openWith: (path: string, code: string | null) => void
  /**
   * A badge scanned while someone is signed in: switch person — at once where a badge alone signs in, else the sign-in
   * screen asks the next person's PIN. A refusal comes back (the person on the tablet stays).
   */
  switchTo: (badgeCode: string) => Promise<FloorProblem | null>
  /** The session ended on the server (a 401 on a call): read the device again; sign-in says why. */
  sessionEnded: () => Promise<void>
  /** The badge of a switch waiting for its PIN (the sign-in screen asks it). */
  pendingSwitch: string | null
  /** The switch is dropped: the person on the tablet stays (Home). */
  cancelSwitch: () => void
  /** The switch is done: Home says who left and who is on; the gate sends the new person on. */
  completeSwitch: (from: string, to: string) => void
  /** Right after a switch: who left, who is on (Home says it once). */
  switched: { from: string; to: string } | null
  /** The browser's install prompt, kept from the page load (set-up's "Install as an app"). */
  installPrompt: InstallPrompt | null
  /** The frame of a screen: its model and its actions (`queue`: the queue's own screen, no "Open queue"). */
  frame: (titleKey: string, options?: { showHome?: boolean; queue?: boolean; crew?: boolean }) => { frame: FrameModel; onFrame: (action: FrameAction) => void }
  /** B-W2b-67: a crew's next step on the sign-in screen: add a person, or a member takes the tablet. */
  crewStep: CrewStep | null
  openCrew: (step: CrewStep) => void
  /** Back to the tablet as it was. */
  closeCrew: () => void
  /** The step is done (`joined`: a new person, who sees the welcome cards); the gate sends them on. */
  crewDone: (joined: boolean) => void
  /** Who stays signed in after the active member left (the sign-in screen's strip); null: nobody. */
  crewLeft: CrewView | null
  /** B-W2b-67: someone just signed in: sign-in's welcome cards come before Home. */
  arriving: boolean
  arrive: () => void
  /** The welcome cards are done: Home, or the job they open (a code for it to take, as `openWith`). */
  arrived: (next?: { path: string; code: string | null }) => void
  /** B-W2b-67: badges scanned on the clock while offline, sealed until sent (tasks/clock/kept.ts). */
  kept: KeptClocks
  keptSnapshot: KeptSnapshot
  /** B-W2b-70: where this tablet opens for this person: Home, or the Line view on a LINE tablet of a team leader. */
  landing: string
  /** The offline queue: actions saved here first, sent in order (queue/queue.ts). */
  queue: FloorQueue
  queueSnapshot: QueueSnapshot
  /** The person's counts and the tablet's label numbers, as the shell shows them. */
  shellQueue: ShellQueue
  /** The version this page runs, the server's latest, and what an update waits for (B-W2a-42). */
  appUpdate: UpdateSnapshot & { step: UpdateStep }
}

/** A crew's step: the next person joins, or a member takes the tablet (tap on their chip, then badge or PIN). */
export type CrewStep = { readonly kind: 'join' } | { readonly kind: 'switch'; readonly workerId: string; readonly name: string }

/** Chrome's `beforeinstallprompt` event (not in the DOM types). */
export interface InstallPrompt extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const FloorContext = createContext<FloorStore | null>(null)

export function useFloor(): FloorStore {
  const store = useContext(FloorContext)
  if (!store) throw new Error('useFloor() outside the floor app')
  return store
}

const subscribeOnline = (notify: () => void) => {
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
  return () => {
    window.removeEventListener('online', notify)
    window.removeEventListener('offline', notify)
  }
}
const useOnline = () =>
  useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  )

type Load = { status: 'loading' } | { status: 'ready'; device: DeviceInfo | null; me: FloorMe | null } | { status: 'unavailable' }

const ENROL = '/floor/enrol'
const SIGN_IN = '/floor/sign-in'
const NOTICE = '/floor/notice'
const HOME = '/floor'
const SYNC = '/floor/sync'
/** B-W2b-67: Clock in & out (SCR-170), open with nobody signed in. */
const CLOCK = '/floor/clock'
/** B-W2b-68: My day (SCR-171), the operator's menu on a home with no tile for it. */
const MY_DAY = '/floor/myday'
/** B-W2b-70: Call for help (SCR-172), the frame's Help button; the Line view (SCR-168), where a LINE tablet lands. */
const HELP = '/floor/help'
const LINE_VIEW = '/floor/lineview'
/** B-W2b-66: a DISPLAY device's page (SCR-173). */
const DISPLAY = '/floor/display'
/** While the app is open, the queue tries to send this often (it sends at once when the network comes back). */
const QUEUE_TIMER_MS = 20_000
const UNAVAILABLE_RETRY_MS = 15_000

/** PLT-242: the browser keeps the tablet's data (persist), and the room left (estimate); unknown where it cannot say. */
async function storageState(): Promise<{ persisted: boolean | null; freeMb: number | null }> {
  try {
    const storage = navigator.storage
    if (!storage) return { persisted: null, freeMb: null }
    const persisted = (await storage.persisted?.()) || ((await storage.persist?.()) ?? null)
    const estimate = await storage.estimate?.()
    const freeMb = estimate?.quota !== undefined && estimate.usage !== undefined ? Math.floor((estimate.quota - estimate.usage) / 1_048_576) : null
    return { persisted: persisted ?? null, freeMb }
  } catch {
    return { persisted: null, freeMb: null }
  }
}

export function FloorApp({ appVersion, catalogues, children }: { appVersion: string; catalogues: Readonly<Record<Locale, LocaleMessages>>; children: ReactNode }) {
  const api = useMemo(() => browserApi(), [])
  const router = useRouter()
  const pathname = usePathname()
  const online = useOnline()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [picked, setPicked] = useState<Locale | null>(null)
  const [sessionLocale, setSessionLocale] = useState<Locale | null>(null)
  const [signedOut, setSignedOut] = useState<SignedOutWhy>(null)
  const [ui, setUi] = useState<{ menu: boolean; help: boolean; language: boolean }>({ menu: false, help: false, language: false })
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const [switched, setSwitched] = useState<{ from: string; to: string } | null>(null)
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null)
  const [crewStep, setCrewStep] = useState<CrewStep | null>(null)
  const [crewLeft, setCrewLeft] = useState<CrewView | null>(null)
  const [arriving, setArriving] = useState(false)
  const scan = useRef<string | null>(null)
  // B-W2b-67: where the welcome cards end: the job they opened, else (null) the person's landing.
  const arrivalTo = useRef<string | null>(null)
  const queue = useMemo(() => new FloorQueue(browserStorage(), api), [api])
  const queueSnapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot)
  const kept = useMemo(() => new KeptClocks(browserKeptStorage(), keptSender(api)), [api])
  const keptSnapshot = useSyncExternalStore(kept.subscribe, kept.getSnapshot, kept.getSnapshot)

  const updater = useMemo(() => new AppUpdater(appVersion), [appVersion])
  const updateSnapshot = useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot)
  const reporter = useMemo(() => new DeviceReporter((state) => sendDeviceState(api, state)), [api])

  const device = load.status === 'ready' ? load.device : null
  const me = load.status === 'ready' ? load.me : null
  const numberKinds = useMemo(() => numberKindsOf(me?.permissions ?? []), [me?.permissions])
  const shellQueue = shellQueueOf(queueSnapshot, { workerId: me?.worker.id ?? null, numberKinds }, { now: new Date(), timeZone: DEFAULT_TIME_ZONE })

  const reload = useCallback(async () => {
    const answer = await fetchDevice(api)
    if (!answer.ok) return setLoad({ status: 'unavailable' })
    const operator = answer.value ? await fetchMe(api) : { ok: true as const, value: null }
    if (!operator.ok) return setLoad({ status: 'unavailable' })
    setLoad({ status: 'ready', device: answer.value, me: operator.value })
  }, [api])

  useEffect(() => {
    setPicked(((value) => (isLocale(value) ? value : null))(readCookie(LOCALE_COOKIE)))
    void reload()
    const keep = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPrompt)
    }
    window.addEventListener('beforeinstallprompt', keep)
    return () => window.removeEventListener('beforeinstallprompt', keep)
  }, [reload])

  // The queue: read what the tablet kept, then send when the network or the screen comes back, and on a timer.
  useEffect(() => {
    void queue.start().then(() => queue.setOnline(navigator.onLine))
    // B-W2b-67: badges kept at a kiosk go with the same beats (a kiosk has nobody signed in, so the queue itself waits).
    void kept.start().then(() => (navigator.onLine ? kept.flush() : undefined))
    const online = () => {
      queue.setOnline(navigator.onLine)
      if (navigator.onLine) void kept.flush()
    }
    const visible = () => {
      if (document.visibilityState !== 'visible') return
      void queue.sync()
      if (navigator.onLine) void kept.flush()
    }
    window.addEventListener('online', online)
    window.addEventListener('offline', online)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', visible)
    const timer = window.setInterval(() => {
      void queue.sync()
      if (navigator.onLine) void kept.flush()
    }, QUEUE_TIMER_MS)
    // PLT-242: ask the browser to keep the tablet's data, and see how much room is left.
    void storageState().then((state) => queue.setStorage(state))
    // The test seam of the live check (never in a production build): the real queue, driven like a screen drives it.
    if (process.env.NODE_ENV !== 'production') (window as unknown as { __nexusFloorQueue?: FloorQueue }).__nexusFloorQueue = queue
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', online)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('focus', visible)
      window.clearInterval(timer)
    }
  }, [queue, kept])
  useEffect(() => {
    queue.setContext({ deviceId: device?.device.id ?? null, workerId: me && !me.pinMustChange ? me.worker.id : null, numberKinds })
  }, [queue, device?.device.id, me, numberKinds])

  // Safe app updates (B-W2a-42): ask for the server's version at start, on a timer, back in view and after each send;
  // take a newer one only when updateStep says nothing can be lost.
  const queued = queuedCount(queueSnapshot.items) + keptSnapshot.waiting
  const step = updateStep({ running: appVersion, latest: updateSnapshot.latest, queued, sending: queueSnapshot.sending, online, path: pathname, triedFor: updateSnapshot.triedFor })
  useEffect(() => {
    void updater.check()
    const timer = window.setInterval(() => void updater.check(), VERSION_CHECK_MS)
    const visible = () => {
      if (document.visibilityState === 'visible') void updater.check()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [updater])
  useEffect(() => {
    if (queueSnapshot.lastSentAt) void updater.check()
  }, [updater, queueSnapshot.lastSentAt])
  useEffect(() => {
    if (step === 'apply') updater.apply()
  }, [updater, step])

  // The tablet's own state for the office (B-W2a-42): at start, when the queue empties or fills, and every few minutes.
  const queuedNow = useRef(queued)
  queuedNow.current = queued
  const deviceId = device?.device.id ?? null
  const queueEmpty = queued === 0
  useEffect(() => {
    if (!deviceId) return
    const tick = async () => {
      const battery = await readBattery()
      await reporter.report({ appVersion, batteryPercent: battery.percent, batteryCharging: battery.charging, queuedActions: queuedNow.current, network: readNetwork() })
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 60_000)
    return () => window.clearInterval(timer)
  }, [reporter, deviceId, appVersion, queueEmpty])

  const setDevice = useCallback((next: DeviceInfo) => setLoad((current) => ({ status: 'ready', device: next, me: current.status === 'ready' ? current.me : null })), [])
  const setMe = useCallback((next: FloorMe | null, why: SignedOutWhy = null) => {
    setLoad((current) => (current.status === 'ready' ? { ...current, me: next } : current))
    if (next === null) {
      setSignedOut(why)
      setSessionLocale(null)
      setSwitched(null)
      setArriving(false)
      setCrewStep(null)
    } else {
      setSignedOut(null)
      setCrewLeft(null)
    }
    setUi({ menu: false, help: false, language: false })
  }, [])

  const signOut = useCallback(
    async (why: Exclude<SignedOutWhy, null>) => {
      // B-W2b-67: on a crew only the active one leaves; the others stay signed in, and the sign-in screen shows them.
      const left = me?.crew ? await leaveCrew(api) : (await apiSignOut(api), null)
      setMe(null, why)
      setCrewLeft(left?.ok ? left.value : null)
      setPendingSwitch(null)
      router.replace(SIGN_IN)
    },
    [api, me?.crew, router, setMe],
  )

  const endTheCrew = useCallback(async () => {
    await endCrew(api)
    setMe(null, 'self')
    setPendingSwitch(null)
    router.replace(SIGN_IN)
  }, [api, router, setMe])

  const switchTo = useCallback(
    async (badgeCode: string): Promise<FloorProblem | null> => {
      if (!device || !me) return null
      if (!device.signIn.badgeOnly) {
        setPendingSwitch(badgeCode)
        router.push(SIGN_IN)
        return null
      }
      const answer = await signIn(api, { badgeCode }, 'switch')
      if (!answer.ok) return answer.problem
      const from = me.worker.displayName
      setMe(answer.value)
      // B-W2b-67: on a crew nobody signed out: the strip shows who is on now.
      if (answer.value.crew) {
        router.replace(answer.value.notice.due ? NOTICE : HOME)
        return null
      }
      setSwitched({ from, to: answer.value.worker.displayName })
      arrivalTo.current = null
      setArriving(true)
      router.replace(answer.value.notice.due ? NOTICE : SIGN_IN)
      return null
    },
    [api, device, me, router, setMe],
  )

  const sessionEnded = useCallback(async () => {
    setMe(null, 'ended')
    setPendingSwitch(null)
    await reload()
  }, [reload, setMe])

  // The screen's language: the operator's (or the one they chose for this session), else the one picked here, else the tenant's.
  const locale = me ? (sessionLocale ?? floorLocale({ person: me.worker.locale, tenant: device?.defaultLocale })) : floorLocale({ picked, tenant: device?.defaultLocale })
  useEffect(() => {
    const html = document.documentElement
    html.lang = locale
    // Pop-ups portalled to <body> follow the floor's density (DS densityAttrs).
    html.setAttribute('data-density', 'floor')
    return () => html.removeAttribute('data-density')
  }, [locale])

  // Where each state belongs.
  useEffect(() => {
    if (load.status !== 'ready') return
    if (!device) {
      if (pathname !== ENROL) router.replace(ENROL)
      return
    }
    // B-W2b-66 (design floor.display): a line board signs nobody in; it opens the board, also by itself after a power cut.
    if (device.rules?.landing === 'LINE_BOARD') {
      if (pathname !== DISPLAY && pathname !== ENROL) router.replace(DISPLAY)
      return
    }
    if (!me) {
      if (pathname !== SIGN_IN && pathname !== ENROL && pathname !== CLOCK) router.replace(SIGN_IN)
      return
    }
    if (me.pinMustChange) {
      if (pathname !== SIGN_IN) router.replace(SIGN_IN)
      return
    }
    if (pathname === SIGN_IN && !pendingSwitch && !crewStep) {
      if (me.notice.due) router.replace(NOTICE)
      else if (!arriving) router.replace(arrivalTo.current ?? (device.rules?.landing === 'LINE_VIEW' && me.permissions.includes('floor.lead') ? LINE_VIEW : HOME))
    }
  }, [load.status, device, me, pathname, pendingSwitch, crewStep, arriving, router])

  // B-W2b-66: nobody presses Try again on a wall screen: while the server does not answer, the app keeps asking.
  useEffect(() => {
    if (load.status !== 'unavailable') return
    const timer = window.setTimeout(() => void reload(), UNAVAILABLE_RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [load, reload])

  const idle = useIdleSignOut({
    idleMs: idleWarnAfterMs(me?.session.idleMinutes ?? 10),
    warnMs: IDLE_WARN_MS,
    enabled: me !== null,
    onSignOut: () => void signOut('idle'),
  })

  const frame = useCallback(
    (titleKey: string, options: { showHome?: boolean; queue?: boolean; crew?: boolean } = {}) => {
      const station = device ? { name: device.device.station?.name ?? null, site: device.site.name } : null
      const model: FrameModel = {
        operator: me ? { name: me.worker.displayName } : null,
        station,
        titleKey,
        online,
        pending: shellQueue.pending,
        refused: shellQueue.refused,
        lastSentAt: shellQueue.lastSentAt,
        queueButton: !options.queue,
        showSynced: Boolean(options.queue),
        showHome: Boolean(me && options.showHome),
        showLanguage: !me,
        menuOpen: ui.menu,
        helpOpen: ui.help,
        languageOpen: ui.language,
        // B-W2b-67: the crew strip on Home, the clock and sign-in (a job's screen keeps its height); the menu's own lines.
        crew: (options.crew ?? !options.showHome) ? (me?.crew ?? crewLeft) : null,
        menu: me ? { clock: me.permissions.includes('floor.work'), myday: me.permissions.includes('floor.work'), addPerson: Boolean(me.rules?.crew), crew: Boolean(me.crew), full: me.crew ? (me.crew.members.length >= me.crew.max ? me.crew.max : null) : null } : undefined,
        idle: me ? { warning: idle.warning, secondsLeft: idle.secondsLeft } : undefined,
      }
      const onFrame = (action: FrameAction) => {
        switch (action.type) {
          case 'home':
            return router.push(HOME)
          case 'menu':
            return setUi((current) => ({ ...current, menu: action.open }))
          case 'help':
            // B-W2b-70 (design floor.help: two taps from any screen): signed in, Help is Call for help; before a sign-in, the words.
            if (me && action.open) return router.push(HELP)
            return setUi((current) => ({ ...current, help: action.open }))
          case 'language':
            return setUi((current) => ({ ...current, language: action.open }))
          case 'locale':
            if (me) return setSessionLocale(action.locale)
            writeCookie(LOCALE_COOKIE, action.locale)
            return setPicked(action.locale)
          case 'sign-out':
            return void signOut('self')
          case 'clock':
            setUi((current) => ({ ...current, menu: false }))
            return router.push(CLOCK)
          case 'myday':
            setUi((current) => ({ ...current, menu: false }))
            return router.push(MY_DAY)
          case 'crew-add':
            setUi((current) => ({ ...current, menu: false }))
            setCrewStep({ kind: 'join' })
            return router.push(SIGN_IN)
          case 'crew-chip':
            setCrewStep({ kind: 'switch', workerId: action.workerId, name: action.name })
            return router.push(SIGN_IN)
          case 'crew-end':
            return void endTheCrew()
          case 'stay':
            return idle.stay()
          case 'queue':
            return router.push(SYNC)
        }
      }
      return { frame: model, onFrame }
    },
    [device, me, online, ui, idle, router, signOut, endTheCrew, crewLeft, shellQueue.pending, shellQueue.refused, shellQueue.lastSentAt],
  )

  const store: FloorStore = {
    api,
    device,
    me,
    locale,
    online,
    reload,
    setDevice,
    setMe,
    signOut,
    signedOut,
    takeScan: () => {
      const code = scan.current
      scan.current = null
      return code
    },
    openScan: (code) => {
      scan.current = code
      router.push('/floor/scan')
    },
    openWith: (path, code) => {
      scan.current = code
      router.push(path)
    },
    switchTo,
    sessionEnded,
    pendingSwitch,
    cancelSwitch: () => {
      setPendingSwitch(null)
      router.replace(HOME)
    },
    completeSwitch: (from, to) => {
      setPendingSwitch(null)
      setSwitched({ from, to })
    },
    switched,
    installPrompt,
    frame,
    crewStep,
    openCrew: (step) => {
      setCrewStep(step)
      router.push(SIGN_IN)
    },
    closeCrew: () => {
      setCrewStep(null)
      router.replace(me ? HOME : SIGN_IN)
    },
    crewDone: (joined) => {
      setCrewStep(null)
      arrivalTo.current = null
      setArriving(joined)
    },
    crewLeft,
    arriving,
    arrive: () => {
      arrivalTo.current = null
      setArriving(true)
    },
    arrived: (next) => {
      arrivalTo.current = next?.path ?? null
      scan.current = next?.code ?? null
      setArriving(false)
    },
    kept,
    keptSnapshot,
    landing: device?.rules?.landing === 'LINE_VIEW' && me?.permissions.includes('floor.lead') ? LINE_VIEW : HOME,
    queue,
    queueSnapshot,
    shellQueue,
    appUpdate: { ...updateSnapshot, step },
  }

  return (
    <I18nProvider locale={locale} messages={catalogues[locale]}>
      <FloorContext.Provider value={store}>{load.status === 'ready' ? children : <Starting status={load.status} onRetry={() => void reload()} frame={frame('start.title')} />}</FloorContext.Provider>
    </I18nProvider>
  )
}

/** Before the device is known: opening, or the server does not answer (with Try again). */
function Starting({ status, onRetry, frame }: { status: 'loading' | 'unavailable'; onRetry: () => void; frame: ReturnType<FloorStore['frame']> }) {
  const t = useT('floor')
  return (
    <FloorFrameView
      frame={frame.frame}
      onFrame={frame.onFrame}
      actions={status === 'unavailable' ? <FloorActionBar actions={[{ label: t('start.retry'), icon: <RotateCcw />, onPress: onRetry }]} /> : undefined}
    >
      {status === 'loading' ? (
        <FloorState tone="info" icon={<Smartphone />} title={t('start.loading')} busy />
      ) : (
        <FloorState tone="warning" icon={<CircleAlert />} title={t('start.unavailable.title')} text={t('start.unavailable.body')} alert />
      )}
    </FloorFrameView>
  )
}
