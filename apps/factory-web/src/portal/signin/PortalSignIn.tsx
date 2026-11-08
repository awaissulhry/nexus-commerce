'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { browserApi } from '../../lib/api/browser'
import { brandingTokensOf } from '../../lib/api/branding'
import { isApiError, type ApiError } from '../../lib/api/errors'
import { writeCookie } from '../../lib/cookies'
import { isLocale, type Locale } from '../../lib/i18n/locales'
import { useLocale, useLocaleSwitch } from '../../lib/i18n/provider'
import {
  continueLink,
  previewLink,
  readEmailSettings,
  readHead,
  readPrivacyNotice,
  readSession,
  readTerms,
  saveFirstVisit,
  saveSummaries,
  signInWithCode,
  startSignIn,
  type SignedIn,
  type SignInHead,
} from './api'
import {
  accessOf,
  addressCookieValue,
  asksSummaries,
  codeProblemOf,
  companyOfLinkToken,
  destinationOf,
  EMAIL_KEY,
  keptNext,
  linkTokenOf,
  NEXT_KEY,
  nextToKeep,
  PORTAL_ADDRESS_COOKIE,
  retryAfterMs,
  wantsChallenge,
  type EndedReason,
  type PortalAddress,
} from './model'
import { PortalSignInView, type PortalSignInViewModel, type SignInAction, type SignInBrand, type SignInScreen } from './view/PortalSignInView'

/**
 * The live SCR-026 (B-W2b-164): one flow per entry address, drawn by `PortalSignInView`.
 *   /p/signin?tenant=&company=&next=&ended=   whose portal (the address, else the one this device remembers) → a session
 *                                             already open goes on (or to its first visit) → the work e-mail → the code
 *   /p/signin/continue#token=…                the mailed link: read without using it → Continue → signed in
 *   /p/signin/privacy?company=<id>            the company's privacy notice, in its own tab beside the sign-in
 * Then the first visit while the portal terms are due, then the page the person was going to, else their Home.
 * Codes and the link's token stay in this component's memory only; the token leaves the address bar at once.
 */

export type SignInStart =
  /** `session`: a portal session already open whose first visit is due (the server render read it). */
  | { kind: 'email'; address: PortalAddress | null; next: string | null; ended: EndedReason | null; session: SignedIn | null }
  | { kind: 'link' }
  | { kind: 'privacy'; companyId: string | null }

/** The view's brand from the head: the portal's name, logo and colour, the company, whom to ask, the legal block. */
function brandOf(head: SignInHead): SignInBrand {
  return {
    ...brandingTokensOf(head.branding, 'portal'),
    companyId: head.company.id,
    companyName: head.company.name,
    contactEmail: head.contact.email,
    legal: head.legal,
  }
}

const storage = {
  get(area: 'local' | 'session', key: string): string | null {
    try {
      return (area === 'local' ? window.localStorage : window.sessionStorage).getItem(key)
    } catch {
      return null
    }
  },
  set(area: 'local' | 'session', key: string, value: string | null): void {
    try {
      const store = area === 'local' ? window.localStorage : window.sessionStorage
      if (value === null) store.removeItem(key)
      else store.setItem(key, value)
    } catch {
      // A browser that keeps nothing: the person goes to Home and types the e-mail again.
    }
  },
}

interface Held {
  /** The portal the e-mail step signs in to (from the head: the tenant's slug and the company's code). */
  portal: PortalAddress | null
  email: string
  /** The mailed link's token (never in the model, never stored). */
  token: string | null
  next: string | null
  /** The terms shown on the first visit: what the yes is for. */
  terms: { id: string; locale: string; sha256: string } | null
  asksSummaries: boolean
}

export function PortalSignIn({ start }: { start: SignInStart }) {
  const api = useMemo(() => browserApi(), [])
  const locale = useLocale()
  const switchLocale = useLocaleSwitch()
  const first: SignInScreen = start.kind === 'link' ? { kind: 'link-checking' } : start.kind === 'privacy' ? { kind: 'privacy', notice: { state: 'loading' } } : { kind: 'loading' }
  const [model, setModel] = useState<PortalSignInViewModel>({ brand: null, screen: first, autoFocus: true })
  const held = useRef<Held>({ portal: null, email: '', token: null, next: start.kind === 'email' ? start.next : null, terms: null, asksSummaries: true })
  const started = useRef(false)
  const localeRef = useRef(locale)
  localeRef.current = locale
  /** The person's own language, on its way after sign-in (the terms wait for it). */
  const ownLocale = useRef<Locale | null>(null)
  /** Retries of a failed read (the terms, the privacy notice). */
  const [tries, setTries] = useState(0)

  const patch = useCallback((change: Partial<PortalSignInViewModel>) => setModel((current) => ({ ...current, ...change })), [])
  const show = useCallback((screen: SignInScreen, extra: Partial<PortalSignInViewModel> = {}) => setModel((current) => ({ brand: current.brand, brandFailed: current.brandFailed, banner: current.banner, offline: current.offline, autoFocus: true, screen, ...extra })), [])
  const checking = useCallback(() => patch({ checking: true }), [patch])

  // The company's colour on every pop-up and tooltip too (D24).
  useEffect(() => brandPortals(model.brand ? checkBranding(model.brand) : null), [model.brand])

  // No network: the steps' buttons are held with the reason.
  useEffect(() => {
    const update = () => patch({ offline: !navigator.onLine })
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [patch])

  /** Whose portal: the head's brand, and the address the e-mail step sends (remembered on this device). */
  const takeHead = useCallback(
    (head: SignInHead) => {
      held.current.portal = { tenant: head.tenant, company: head.company.code }
      writeCookie(PORTAL_ADDRESS_COOKIE, addressCookieValue(held.current.portal))
      patch({ brand: brandOf(head), brandFailed: false })
    },
    [patch],
  )

  /** Signed in: the page the person was going to, else Home (`/p/<party code>`: the session read names the code). */
  const go = useCallback(
    async (signed: Pick<SignedIn, 'party'>) => {
      show({ kind: 'opening' }, { banner: null })
      const party = signed.party.code ? signed.party : ((await readSession(api).catch(() => null))?.party ?? signed.party)
      window.location.replace(destinationOf(held.current.next, party))
    },
    [api, show],
  )

  /** The terms in force in the page's language (again when the person changes the language on the first visit). */
  const termsRead = useRef(0)
  const loadTerms = useCallback(
    async (language: Locale) => {
      const mine = ++termsRead.current
      setModel((current) => (current.screen.kind === 'first-visit' ? { ...current, screen: { ...current.screen, terms: { state: 'loading' } } } : current))
      try {
        const read = await readTerms(api, language)
        if (mine !== termsRead.current) return
        const notice = read.notice
        held.current.terms = notice ? { id: notice.id, locale: notice.locale, sha256: notice.sha256 } : null
        setModel((current) =>
          current.screen.kind === 'first-visit'
            ? { ...current, screen: { ...current.screen, terms: notice ? { state: 'ready', label: notice.label, body: notice.body, locale: notice.locale, languageReady: notice.languageReady } : { state: 'failed' } } }
            : current,
        )
      } catch {
        if (mine !== termsRead.current) return
        held.current.terms = null
        setModel((current) => (current.screen.kind === 'first-visit' ? { ...current, screen: { ...current.screen, terms: { state: 'failed' } } } : current))
      }
    },
    [api],
  )

  /** The first visit: name, language, summaries (only while none were chosen), the terms once. */
  const firstVisit = useCallback(
    (signed: SignedIn) => {
      held.current.asksSummaries = true
      // After sign-in the person's own language wins: the terms are read once the page speaks it (the effect below).
      const own = isLocale(signed.user.locale) ? signed.user.locale : null
      if (own && own !== localeRef.current && switchLocale) {
        ownLocale.current = own
        switchLocale(own)
      }
      show({ kind: 'first-visit', displayName: signed.user.displayName, asksSummaries: true, terms: { state: 'loading' } }, { banner: null })
      void readEmailSettings(api)
        .then((settings) => {
          const asks = asksSummaries(settings.topics)
          held.current.asksSummaries = asks
          setModel((current) => (current.screen.kind === 'first-visit' ? { ...current, screen: { ...current.screen, asksSummaries: asks } } : current))
        })
        .catch(() => undefined)
    },
    [api, show, switchLocale],
  )

  /** A session is open: remember the portal and this tab's address, then the first visit or the page. */
  const signedIn = useCallback(
    (signed: SignedIn) => {
      if (held.current.portal) {
        held.current.portal = { tenant: held.current.portal.tenant, company: signed.company.code }
        writeCookie(PORTAL_ADDRESS_COOKIE, addressCookieValue(held.current.portal))
      }
      storage.set('session', EMAIL_KEY, signed.user.email)
      held.current.next = held.current.next ?? keptNext(storage.get('local', NEXT_KEY), Date.now())
      storage.set('local', NEXT_KEY, null)
      if (signed.termsDue) firstVisit(signed)
      else void go(signed)
    },
    [firstVisit, go],
  )

  /** A refusal after the address was proved (paused, ended, …): said above step 1, the address kept. */
  const refusedAccess = useCallback(
    (error: ApiError): boolean => {
      const access = accessOf(error)
      if (!access) return false
      show({ kind: 'email', email: held.current.email }, { banner: { kind: 'paused', problem: access.problem, endedOn: access.endedOn }, autoFocus: false })
      return true
    },
    [show],
  )

  // ── arrival ──
  useEffect(() => {
    if (started.current) return
    started.current = true

    if (start.kind === 'privacy') {
      if (!start.companyId) return patch({ screen: { kind: 'privacy', notice: { state: 'missing' } } })
      void readHead(api, { companyId: start.companyId }).then(takeHead, () => patch({ brandFailed: true }))
      return
    }

    if (start.kind === 'link') {
      // The token is read once, then gone from the address bar (a screenshot or a copied address must not carry it); a
      // link pasted into this same tab later (only the fragment changes, no new page) is read the same way.
      let attempt = 0
      const open = (arrival: boolean) => {
        const token = linkTokenOf(window.location.hash)
        if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
        if (!token) return arrival ? show({ kind: 'link-dead' }) : undefined
        const mine = ++attempt
        held.current.token = token
        show({ kind: 'link-checking' }, { banner: null })
        const companyId = companyOfLinkToken(token)
        if (companyId) void readHead(api, { companyId }).then((head) => mine === attempt && takeHead(head), () => mine === attempt && patch({ brandFailed: true }))
        void previewLink(api, token, checking)
          .then((read) => {
            if (mine !== attempt) return
            held.current.email = read.email
            show({ kind: 'link', company: read.company.name, email: read.email })
          })
          .catch((error: unknown) => {
            if (mine !== attempt) return
            if (isApiError(error) && error.kind === 'not_found') return show({ kind: 'link-dead' })
            // Reading the link failed: Continue still works (it is the press that uses the link).
            const challenged = isApiError(error) && wantsChallenge(error)
            const wait = isApiError(error) && !challenged ? retryAfterMs(error) : null
            show({ kind: 'link', company: null, email: null }, wait ? { waitUntil: Date.now() + wait } : { problem: challenged ? 'checkFailed' : 'signInFailed' })
          })
      }
      open(true)
      window.addEventListener('hashchange', () => open(false))
      return
    }

    // /p/signin: a session already open goes to its first visit (the server sent any other on); else whose portal, step 1.
    const { address, ended, session } = start
    void (async () => {
      if (session) {
        void readHead(api, { companyId: session.company.id }).then(takeHead, () => patch({ brandFailed: true }))
        return session.termsDue ? firstVisit(session) : void go(session)
      }
      const email = ended ? (storage.get('session', EMAIL_KEY) ?? '') : ''
      held.current.email = email
      const banner = ended ? { kind: 'ended' as const, reason: ended } : null
      if (!address) return show({ kind: 'unknown', reason: 'none' }, { banner: null })
      try {
        takeHead(await readHead(api, address))
        show({ kind: 'email', email }, { banner, autoFocus: !banner })
      } catch (error) {
        if (isApiError(error) && error.kind === 'not_found') return show({ kind: 'unknown', reason: 'not-found' })
        // The branding could not be read: the page still works with the address it was given.
        held.current.portal = address
        patch({ brandFailed: true })
        show({ kind: 'email', email }, { banner, brandFailed: true })
      }
    })()
  }, [api, checking, firstVisit, go, patch, show, start, takeHead])

  // The first visit's terms in the page's language: on arrival, again when the person changes the language, and on a retry.
  const onFirstVisit = model.screen.kind === 'first-visit'
  useEffect(() => {
    if (!onFirstVisit) return
    if (ownLocale.current && ownLocale.current !== locale) return
    ownLocale.current = null
    void loadTerms(locale)
  }, [loadTerms, locale, onFirstVisit, tries])

  // The privacy notice in the page's language.
  useEffect(() => {
    if (start.kind !== 'privacy' || !start.companyId) return
    let live = true
    const companyId = start.companyId
    patch({ screen: { kind: 'privacy', notice: { state: 'loading' } } })
    readPrivacyNotice(api, companyId, locale).then(
      (read) => live && patch({ screen: { kind: 'privacy', notice: read ? { state: 'ready', label: read.notice.label, body: read.notice.body, locale: read.notice.locale, languageReady: read.notice.languageReady } : { state: 'missing' } } }),
      () => live && patch({ screen: { kind: 'privacy', notice: { state: 'failed' } } }),
    )
    return () => {
      live = false
    }
  }, [api, locale, patch, start, tries])

  // ── what the person does ──
  const sendEmail = async (email: string, resend: boolean) => {
    const portal = held.current.portal
    if (!portal) return show({ kind: 'unknown', reason: 'none' })
    held.current.email = email
    patch(resend ? { resending: true, resent: false } : { busy: true, problem: null, fieldErrors: undefined })
    try {
      const sent = await startSignIn(api, { ...portal, email }, checking)
      const kept = nextToKeep(held.current.next, Date.now())
      if (kept) storage.set('local', NEXT_KEY, kept)
      const resendAt = Date.now() + sent.resendAfterSeconds * 1000
      if (resend) setModel((current) => (current.screen.kind === 'code' ? { ...current, screen: { ...current.screen, resendAt }, resending: false, resent: true, checking: false, code: null, waitUntil: null } : current))
      else show({ kind: 'code', email, resendAt }, { banner: null })
    } catch (error) {
      if (!isApiError(error)) throw error
      const wait = wantsChallenge(error) ? null : retryAfterMs(error)
      if (resend) return patch({ resending: false, checking: false, ...(wait ? { resendWaitUntil: Date.now() + wait } : { problem: wantsChallenge(error) ? 'checkFailed' : 'sendFailed' }) })
      if (error.kind === 'invalid') return patch({ busy: false, checking: false, fieldErrors: { email: 'format' } })
      patch({ busy: false, checking: false, ...(wait ? { waitUntil: Date.now() + wait } : { problem: wantsChallenge(error) ? 'checkFailed' : 'sendFailed' }) })
    }
  }

  const sendCode = async (code: string) => {
    const portal = held.current.portal
    if (!portal) return show({ kind: 'unknown', reason: 'none' })
    patch({ busy: true, problem: null, code: null })
    try {
      signedIn(await signInWithCode(api, { ...portal, email: held.current.email, code }, checking))
    } catch (error) {
      if (!isApiError(error)) throw error
      if (refusedAccess(error)) return
      if (wantsChallenge(error)) return patch({ busy: false, checking: false, problem: 'checkFailed' })
      const problem = codeProblemOf(error)
      if (problem.kind === 'wait') return patch({ busy: false, checking: false, waitUntil: Date.now() + problem.ms })
      if (problem.kind === 'failed') return patch({ busy: false, checking: false, problem: 'signInFailed' })
      patch({ busy: false, checking: false, code: problem })
    }
  }

  const continueWithLink = async () => {
    const token = held.current.token
    if (!token) return show({ kind: 'link-dead' })
    patch({ busy: true, problem: null })
    try {
      const signed = await continueLink(api, token, checking)
      held.current.token = null
      signedIn(signed)
    } catch (error) {
      if (!isApiError(error)) throw error
      if (error.kind === 'not_found') {
        held.current.token = null
        return show({ kind: 'link-dead' })
      }
      if (refusedAccess(error)) return
      const wait = wantsChallenge(error) ? null : retryAfterMs(error)
      patch({ busy: false, checking: false, ...(wait ? { waitUntil: Date.now() + wait } : { problem: wantsChallenge(error) ? 'checkFailed' : 'signInFailed' }) })
    }
  }

  const saveFirst = async (input: { displayName: string; locale: Locale; summaries: 'INSTANT' | 'DAILY' | 'WEEKLY' }) => {
    const terms = held.current.terms
    if (!terms) return
    patch({ busy: true, problem: null })
    try {
      if (held.current.asksSummaries) await saveSummaries(api, input.summaries)
      await saveFirstVisit(api, { displayName: input.displayName, locale: input.locale, terms })
      const session = await readSession(api)
      if (!session) return show({ kind: 'email', email: held.current.email }, { banner: { kind: 'ended', reason: 'revoked' } })
      return void go(session)
    } catch (error) {
      if (isApiError(error) && error.kind === 'conflict') {
        patch({ busy: false, problem: 'termsChanged' })
        return setTries((n) => n + 1)
      }
      if (isApiError(error) && error.kind === 'signed_out') return show({ kind: 'email', email: held.current.email }, { banner: { kind: 'ended', reason: 'revoked' } })
      patch({ busy: false, problem: 'saveFailed' })
    }
  }

  const onAction = (action: SignInAction) => {
    switch (action.type) {
      case 'send':
        return void sendEmail(action.email, false)
      case 'resend':
        return void sendEmail(held.current.email, true)
      case 'code':
        return void sendCode(action.code)
      case 'other-email':
        return show({ kind: 'email', email: held.current.email }, { banner: null })
      case 'continue':
        return void continueWithLink()
      case 'new-link':
        held.current.next = held.current.next ?? keptNext(storage.get('local', NEXT_KEY), Date.now())
        return held.current.portal ? show({ kind: 'email', email: held.current.email }, { banner: null }) : show({ kind: 'unknown', reason: 'none' })
      case 'first-visit':
        return void saveFirst(action)
      case 'retry':
        return setTries((n) => n + 1)
      case 'hide-banner':
        return patch({ banner: null })
    }
  }

  return <PortalSignInView model={model} onAction={onAction} />
}
