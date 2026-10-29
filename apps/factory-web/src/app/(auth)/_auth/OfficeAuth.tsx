'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { browserApi } from '../../../lib/api/browser'
import { readCookie, writeCookie } from '../../../lib/cookies'
import { SCOPE_COOKIE } from '../../../lib/session/scope-memory'
import { acceptInvitation, chooseRequiredPassword, confirmReset, previewInvitation, requestReset, signIn, type OpenSession, type SignInOutcome } from './auth-api'
import { TENANT_COOKIE, tokenFromFragment } from './auth-model'
import { OfficeAuthView, type AuthAction, type AuthScreen, type OfficeAuthViewModel } from './view/OfficeAuthView'

/**
 * The live SCR-001: one flow per entry address, drawn by `OfficeAuthView`.
 *   /sign-in            company, email, password → the code (app or recovery) → or a required new password → office
 *   /forgot-password    a reset link by email; the same answer for every address
 *   /reset-password     `#token=…` from the mail → a new password → sign in
 *   /accept-invitation  `#token=…` from the mail → name and password → signed in → the authenticator offered
 * Secrets stay in this component's memory (a ref): the password until the code step is done, the forced-change and the
 * link tokens. A link's token is read from the address's fragment once and removed from the address bar.
 */

export type AuthStart = 'sign-in' | 'forgot' | 'reset' | 'invite'

function firstScreen(start: AuthStart, company: string): AuthScreen {
  switch (start) {
    case 'sign-in':
    case 'forgot':
      return { kind: start, company, email: '' }
    case 'reset':
      return { kind: 'reset' }
    case 'invite':
      return { kind: 'invite-checking' }
  }
}

interface Held {
  company?: string
  email?: string
  password?: string
  /** The forced new password's token (sign-in answer). */
  resetToken?: string
  /** A mailed link's token (reset or invitation). */
  linkToken?: string
  /** The invitation's address, for the password rules. */
  inviteEmail?: string
  /** Where an accepted invitation's session goes. */
  opened?: OpenSession
}

/** `company`: the sign-in name remembered on this device (the page reads its cookie on the server). */
export function OfficeAuth({ start, company = '' }: { start: AuthStart; company?: string }) {
  const router = useRouter()
  const api = useMemo(() => browserApi(), [])
  const [model, setModel] = useState<OfficeAuthViewModel>(() => ({ screen: firstScreen(start, company), autoFocus: true }))
  const held = useRef<Held>({})
  /** A link's token is read once (and removed from the address bar once), even when React runs the effect twice. */
  const started = useRef(false)

  const show = useCallback((screen: AuthScreen, extra: Partial<OfficeAuthViewModel> = {}) => setModel({ screen, autoFocus: true, ...extra }), [])
  const wait = useCallback(() => setModel((current) => ({ ...current, busy: true, problem: null })), [])
  const refuse = useCallback((problem: OfficeAuthViewModel['problem']) => setModel((current) => ({ ...current, busy: false, problem })), [])

  /** A session is open: remember the company's sign-in name on this device and go in. */
  const enter = useCallback(
    (opened: OpenSession, to = opened.to) => {
      writeCookie(TENANT_COOKIE, opened.tenantSlug)
      held.current = {}
      router.replace(to)
    },
    [router],
  )

  const follow = useCallback(
    (outcome: SignInOutcome) => {
      const { email = '' } = held.current
      switch (outcome.kind) {
        case 'open':
          return enter(outcome)
        case 'code':
          return show({ kind: 'code', email, recovery: false })
        case 'change':
          held.current.resetToken = outcome.resetToken
          return show({ kind: 'change', email })
        case 'problem':
          // A forced change whose time ran out goes back to the start, with the reason.
          if (outcome.problem === 'changeExpired') {
            held.current = { company: held.current.company, email }
            return show({ kind: 'sign-in', company: held.current.company ?? '', email }, { problem: outcome.problem })
          }
          return refuse(outcome.problem)
      }
    },
    [enter, refuse, show],
  )

  // A mailed link's first screen: its token, read once and then gone from the address bar.
  useEffect(() => {
    if (started.current || (start !== 'reset' && start !== 'invite')) return
    started.current = true
    const token = tokenFromFragment(window.location.hash)
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    if (!token) return show({ kind: 'link-missing' })
    held.current.linkToken = token
    if (start === 'invite') {
      void previewInvitation(api, token).then((answer) => {
        if (answer.kind === 'invitation') {
          held.current.inviteEmail = answer.invitation.email
          show({ kind: 'invite', tenant: answer.invitation.tenant.name, email: answer.invitation.email, displayName: answer.invitation.displayName, expiresAt: answer.invitation.expiresAt })
        } else if (answer.kind === 'link-invalid') show({ kind: 'link-invalid', link: 'invite' })
        else show({ kind: 'invite-checking' }, { problem: answer.problem })
      })
    }
  }, [api, show, start])

  const onAction = async (action: AuthAction) => {
    const scope = readCookie(SCOPE_COOKIE)
    switch (action.type) {
      case 'sign-in':
        held.current = { company: action.company.trim(), email: action.email.trim(), password: action.password }
        wait()
        return follow(await signIn(api, action, scope))
      case 'code': {
        const { company = '', email = '', password = '' } = held.current
        wait()
        return follow(await signIn(api, { company, email, password, code: action.code }, scope))
      }
      case 'recovery':
        return show({ kind: 'code', email: held.current.email ?? '', recovery: action.on })
      case 'restart':
        held.current = { company: held.current.company }
        return show({ kind: 'sign-in', company: held.current.company ?? '', email: '' })
      case 'new-password': {
        wait()
        if (model.screen.kind === 'change') {
          const { company = '', email = '', resetToken = '' } = held.current
          held.current.password = action.password
          return follow(await chooseRequiredPassword(api, { resetToken, company, email, password: action.password }, scope))
        }
        const answer = await confirmReset(api, { token: held.current.linkToken ?? '', password: action.password })
        if (answer.kind === 'done') {
          held.current = {}
          return show({ kind: 'reset-done' })
        }
        if (answer.kind === 'link-invalid') return show({ kind: 'link-invalid', link: 'reset' })
        return refuse(answer.problem)
      }
      case 'forgot': {
        wait()
        const answer = await requestReset(api, action)
        if (answer.kind === 'problem') return refuse(answer.problem)
        return show({ kind: 'forgot-sent', email: action.email.trim() })
      }
      case 'accept': {
        wait()
        const answer = await acceptInvitation(api, { token: held.current.linkToken ?? '', displayName: action.displayName, password: action.password }, scope)
        if (answer.kind === 'link-invalid') return show({ kind: 'link-invalid', link: 'invite' })
        // Joined, but no role yet: the invitation is used, so the form does not come back.
        if (answer.kind === 'problem' && answer.problem === 'noCompany') return show({ kind: 'invite-done', mfaRequired: false, noCompany: true })
        if (answer.kind === 'problem') return refuse(answer.problem)
        held.current = { opened: answer }
        return show({ kind: 'invite-done', mfaRequired: answer.mfaRequired })
      }
      case 'enrol': {
        const opened = held.current.opened
        if (!opened) return
        setModel((current) => ({ ...current, busy: true }))
        return enter(opened, action.now ? opened.authenticator : opened.entry)
      }
    }
  }

  return <OfficeAuthView model={model} onAction={(action) => void onAction(action)} />
}
