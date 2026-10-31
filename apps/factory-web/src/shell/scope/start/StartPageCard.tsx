'use client'

import { useEffect, useMemo, useState } from 'react'
import { listKeyOf } from '@nexus/factory-domain/views/state'
import { listViews } from '../../../areas/_shared/list-tools/api'
import { readCookie, writeCookie } from '../../../lib/cookies'
import { useScopedT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { recallStart, rememberScope, SCOPE_COOKIE } from '../../../lib/session/scope-memory'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../nav/office-nav'
import { useOfficeScope } from '../scope-context'
import { sameStart, startAddressOf, startChoiceOf, startPagesOf, type StartChoice } from './start-page'
import { StartPageView, type StartPageViewModel } from './view/StartPageView'

/**
 * B-W2b-05: the live "Where I work" card on My profile (SCR-007; design shell.scope sec:defaults). It reads the person's
 * start page from the scope cookie, offers their list pages and each page's saved views (GET /views?listKey=, the list
 * tools' own read), and keeps the choice with their company and site (per person, on this device).
 */
export function StartPageCard() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const named = useScopedT('shell')
  const person = useMemo(() => ({ tenantId: session.tenant.id, userId: session.user.id }), [session.tenant.id, session.user.id])
  const nav = useMemo(() => officeNavFor(permissionCheck(session.permissions)), [session.permissions])
  const pages = useMemo(() => startPagesOf(nav).map((page) => ({ href: page.href, label: named(page.label), area: named(page.area) })), [nav, named])

  const [kept, setKept] = useState<StartChoice>({ kind: 'today' })
  const [draft, setDraft] = useState<StartChoice | { kind: 'view'; page: string | null; viewId: null }>({ kind: 'today' })
  const [views, setViews] = useState<StartPageViewModel['views']>({ status: 'idle' })
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const choice = startChoiceOf(recallStart(readCookie(SCOPE_COOKIE), person))
    setKept(choice)
    setDraft(choice)
  }, [person])

  const page = draft.kind === 'view' ? draft.page : null
  useEffect(() => {
    const key = page ? listKeyOf(page) : null
    if (!key) {
      setViews({ status: 'idle' })
      return
    }
    let live = true
    setViews({ status: 'loading' })
    listViews(api, key)
      .then((answer) => live && setViews({ status: 'ready', items: answer.views.map((view) => ({ id: view.id, name: view.name })) }))
      .catch(() => live && setViews({ status: 'error' }))
    return () => {
      live = false
    }
  }, [api, page])

  const complete: StartChoice | null = draft.kind === 'today' ? draft : draft.page && draft.viewId ? { kind: 'view', page: draft.page, viewId: draft.viewId } : null
  const changed = complete === null || !sameStart(complete, kept)

  return (
    <StartPageView
      model={{
        choice: draft.kind,
        pages,
        page,
        views,
        viewId: draft.kind === 'view' ? draft.viewId : null,
        changed,
        saved,
      }}
      actions={{
        onChoice: (choice) => {
          setSaved(false)
          setDraft(choice === 'today' ? { kind: 'today' } : kept.kind === 'view' ? kept : { kind: 'view', page: null, viewId: null })
        },
        onPage: (next) => {
          setSaved(false)
          setDraft({ kind: 'view', page: next, viewId: null })
        },
        onView: (viewId) => {
          setSaved(false)
          setDraft((current) => (current.kind === 'view' && current.page ? { kind: 'view', page: current.page, viewId } : current))
        },
        onDiscard: () => {
          setDraft(kept)
          setSaved(false)
        },
        onSave: () => {
          if (!complete || !scope.company) return
          writeCookie(SCOPE_COOKIE, rememberScope(readCookie(SCOPE_COOKIE), person, { company: scope.company.code, site: scope.siteId, start: startAddressOf(complete) }), 400)
          setKept(complete)
          setSaved(true)
        },
      }}
    />
  )
}
