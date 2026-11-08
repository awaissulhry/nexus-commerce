'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { browserApi } from '../../../lib/api/browser'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { OfficeMe } from '../../../lib/api/office'
import { readCookie, writeCookie } from '../../../lib/cookies'
import { companyPrefix } from '../../../lib/session/session'
import { officeSignIn, officeSignOut, openFromMail, readOfficeMe } from './api'
import { approvalsHome, mailKeyFromFragment, officeAddress, signInProblemOf, TENANT_COOKIE, type OfficeApprovalViewModel, type OfficeStage } from './model'
import { OfficeApprovalView } from './view/OfficeApprovalView'

/**
 * `/l/approve#key=am1…` — an office approval opened from its e-mail (PLT-089). The key is read from the fragment once and
 * taken out of the address bar (kept in memory only; it grants nothing by itself). An office session already open goes
 * straight on; else the quick sign-in (the office's own sign-in API, with its two-factor rule) — then `POST
 * /approvals/mail-open {key}` says where it opens, and the page goes to the office page that holds it (Home › Approvals'
 * review). The password lives only in this component's memory until the code step is done.
 */
/** `signedIn`: the route read the office session on the server (a signed-out visit goes straight to the sign-in). */
export function OfficeApproval({ signedIn }: { signedIn: boolean }) {
  const api = useMemo(() => browserApi(), [])
  const [model, setModel] = useState<OfficeApprovalViewModel>({ stage: { kind: 'checking' }, company: '', email: '', code: '', busy: false, problem: null })
  const key = useRef<string | null>(null)
  const held = useRef<{ company: string; email: string; password: string } | null>(null)
  const started = useRef(false)

  const show = useCallback((stage: OfficeStage, extra: Partial<OfficeApprovalViewModel> = {}) => setModel((current) => ({ ...current, stage, busy: false, problem: null, ...extra })), [])

  /** Signed in: the session's companies, then the mailed approval's place, then there. */
  const open = useCallback(
    async (me: OfficeMe) => {
      const own = me.company ?? me.companies[0] ?? null
      if (me.mfa.required && !me.mfa.enabled) return show({ kind: 'setup-2fa', href: own ? `${companyPrefix(own.code)}/me#authenticator` : '/sign-in' })
      if (!key.current) return show({ kind: 'missing' })
      show({ kind: 'opening' })
      try {
        const scoped: ApiClient = own ? browserApi({ company: own.code }) : api
        const opened = await openFromMail(scoped, key.current)
        const href = officeAddress(opened, me.companies, me.company)
        if (!href) return show({ kind: 'not-valid', home: null })
        if (!opened.waiting) return show({ kind: 'decided', href, label: opened.record.label })
        show({ kind: 'open', href, label: opened.record.label })
        window.location.assign(href)
      } catch (error) {
        if (isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden')) return show({ kind: 'not-valid', home: approvalsHome(own) })
        if (isApiError(error) && error.kind === 'signed_out') return show({ kind: 'sign-in' })
        show({ kind: 'error' })
      }
    },
    [api, show],
  )

  const check = useCallback(async () => {
    show({ kind: 'checking' })
    try {
      await open(await readOfficeMe(api))
    } catch (error) {
      if (isApiError(error) && error.kind === 'signed_out') return show(key.current ? { kind: 'sign-in' } : { kind: 'missing' })
      show({ kind: 'error' })
    }
  }, [api, open, show])

  useEffect(() => {
    if (started.current) return
    started.current = true
    key.current = mailKeyFromFragment(window.location.hash)
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    setModel((current) => ({ ...current, company: readCookie(TENANT_COOKIE) ?? '' }))
    if (signedIn) void check()
    else show(key.current ? { kind: 'sign-in' } : { kind: 'missing' })
  }, [check, show, signedIn])

  const signIn = async (input: { company: string; email: string; password: string; code?: string }) => {
    setModel((current) => ({ ...current, busy: true, problem: null, company: input.company, email: input.email }))
    try {
      const answer = await officeSignIn(api, input)
      if (answer.status === 'totp_required') {
        held.current = { company: input.company, email: input.email, password: input.password }
        return show({ kind: 'code' }, { code: '' })
      }
      if (answer.status === 'password_change_required') {
        held.current = null
        return show({ kind: 'change-password' })
      }
      held.current = null
      const me = await readOfficeMe(api)
      writeCookie(TENANT_COOKIE, me.tenant.slug)
      await open(me)
    } catch (error) {
      const problem = isApiError(error) ? signInProblemOf(error, input.code === undefined ? 'password' : 'code') : 'unavailable'
      setModel((current) => ({ ...current, busy: false, problem, ...(input.code !== undefined ? { code: '' } : {}) }))
    }
  }

  return (
    <OfficeApprovalView
      model={model}
      actions={{
        onSignIn: (input) => void signIn(input),
        onCode: (code) => setModel((current) => ({ ...current, code, problem: null })),
        onCodeComplete: (code) => {
          const kept = held.current
          if (!kept || model.busy) return
          void signIn({ ...kept, code })
        },
        onRestart: () => {
          held.current = null
          show({ kind: 'sign-in' }, { code: '' })
        },
        onSignOut: () => {
          void officeSignOut(api)
            .catch(() => undefined)
            .then(() => show(key.current ? { kind: 'sign-in' } : { kind: 'missing' }))
        },
        onRetry: () => void check(),
      }}
    />
  )
}
