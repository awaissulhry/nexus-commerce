'use client'

import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { readOrganisation, type Organisation } from '../api'
import { calendarCan, readProblemOf, todayIn } from '../model'
import { OrganisationPrintView } from './view/OrganisationPrintView'

/**
 * `/w/<company>/plant/calendar/organisation` (SCR-267-org-print, a new tab): the organisation chart for the notice board,
 * read once with the top bar's site (GET /safety/organisation, safety.view; the terms in force today).
 */
export function OrganisationPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const can = useMemo(() => calendarCan(session.permissions), [session.permissions])
  const [at] = useState(() => new Date().toISOString())
  const [localToday] = useState(() => todayIn(DEFAULT_TIME_ZONE))
  const [organisation, setOrganisation] = useState<{ value: Organisation | null; problem: string | null }>({ value: null, problem: null })
  const siteId = scope.siteId

  useEffect(() => {
    if (!can.view) return
    let live = true
    setOrganisation({ value: null, problem: null })
    readOrganisation(api, { siteId, ended: false }).then(
      (value) => live && setOrganisation({ value, problem: null }),
      (error: unknown) => live && setOrganisation({ value: null, problem: readProblemOf(error) }),
    )
    return () => {
      live = false
    }
  }, [api, can.view, siteId])

  return (
    <OrganisationPrintView
      model={{ person: session.user.displayName, at, company: session.company?.name ?? '', site: scope.site?.name ?? null, today: organisation.value?.today ?? localToday, canView: can.view, organisation }}
    />
  )
}
