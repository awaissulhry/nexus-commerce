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
import { fetchDevice, fetchMe, signIn, signOut as apiSignOut, type DeviceInfo, type FloorMe, type FloorProblem } from './api'
import { FloorFrameView, type FrameAction, type FrameModel } from './frame/view/FloorFrameView'
import { FloorState } from './frame/view/FloorState'
import { floorLocale, IDLE_WARN_MS, idleWarnAfterMs } from './model'
import type { SignedOutWhy } from './sign-in/view/SignInView'

/**
 * The floor app (SCR-020 … 025): one client root under `/floor` that knows the device and the signed-in operator,
 * speaks their language, keeps the frame's pop-ups and the idle sign-out, and sends each screen where it belongs:
 *
 *   no device token            → /floor/enrol      (SCR-020)
 *   enrolled, nobody signed in → /floor/sign-in    (SCR-021)
 *   a PIN to choose            → /floor/sign-in    (the new-PIN step)
 *   just signed in             → /floor/notice     when the worker notice is due (SCR-025), else /floor (SCR-022)
 * `/floor/enrol` stays open on an enrolled tablet (it asks "Replace?" first). A 401 from any call means the session
 * ended (idle, shift end, the office revoked it): the app reads the device again and shows sign-in with the reason.
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
  /** A code scanned on Home, for Scan anything to open. */
  takeScan: () => string | null
  openScan: (code: string) => void
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
  /** The frame of a screen: its model and its actions. */
  frame: (titleKey: string, options?: { showHome?: boolean }) => { frame: FrameModel; onFrame: (action: FrameAction) => void }
}

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

export function FloorApp({ catalogues, children }: { catalogues: Readonly<Record<Locale, LocaleMessages>>; children: ReactNode }) {
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
  const scan = useRef<string | null>(null)

  const device = load.status === 'ready' ? load.device : null
  const me = load.status === 'ready' ? load.me : null

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

  const setDevice = useCallback((next: DeviceInfo) => setLoad((current) => ({ status: 'ready', device: next, me: current.status === 'ready' ? current.me : null })), [])
  const setMe = useCallback((next: FloorMe | null, why: SignedOutWhy = null) => {
    setLoad((current) => (current.status === 'ready' ? { ...current, me: next } : current))
    if (next === null) {
      setSignedOut(why)
      setSessionLocale(null)
      setSwitched(null)
    } else setSignedOut(null)
    setUi({ menu: false, help: false, language: false })
  }, [])

  const signOut = useCallback(
    async (why: Exclude<SignedOutWhy, null>) => {
      await apiSignOut(api)
      setMe(null, why)
      setPendingSwitch(null)
      router.replace(SIGN_IN)
    },
    [api, router, setMe],
  )

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
      setSwitched({ from, to: answer.value.worker.displayName })
      router.replace(answer.value.notice.due ? NOTICE : HOME)
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
    if (!me) {
      if (pathname !== SIGN_IN && pathname !== ENROL) router.replace(SIGN_IN)
      return
    }
    if (me.pinMustChange) {
      if (pathname !== SIGN_IN) router.replace(SIGN_IN)
      return
    }
    if (pathname === SIGN_IN && !pendingSwitch) router.replace(me.notice.due ? NOTICE : HOME)
  }, [load.status, device, me, pathname, pendingSwitch, router])

  const idle = useIdleSignOut({
    idleMs: idleWarnAfterMs(me?.session.idleMinutes ?? 10),
    warnMs: IDLE_WARN_MS,
    enabled: me !== null,
    onSignOut: () => void signOut('idle'),
  })

  const frame = useCallback(
    (titleKey: string, options: { showHome?: boolean } = {}) => {
      const station = device ? { name: device.device.station?.name ?? null, site: device.site.name } : null
      const model: FrameModel = {
        operator: me ? { name: me.worker.displayName } : null,
        station,
        titleKey,
        online,
        pending: 0,
        showHome: Boolean(me && options.showHome),
        showLanguage: !me,
        menuOpen: ui.menu,
        helpOpen: ui.help,
        languageOpen: ui.language,
        idle: me ? { warning: idle.warning, secondsLeft: idle.secondsLeft } : undefined,
      }
      const onFrame = (action: FrameAction) => {
        switch (action.type) {
          case 'home':
            return router.push(HOME)
          case 'menu':
            return setUi((current) => ({ ...current, menu: action.open }))
          case 'help':
            return setUi((current) => ({ ...current, help: action.open }))
          case 'language':
            return setUi((current) => ({ ...current, language: action.open }))
          case 'locale':
            if (me) return setSessionLocale(action.locale)
            writeCookie(LOCALE_COOKIE, action.locale)
            return setPicked(action.locale)
          case 'sign-out':
            return void signOut('self')
          case 'stay':
            return idle.stay()
        }
      }
      return { frame: model, onFrame }
    },
    [device, me, online, ui, idle, router, signOut],
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
