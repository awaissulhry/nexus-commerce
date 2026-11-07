'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { isApiError } from '../../../../../lib/api/errors'
import { useLocale } from '../../../../../lib/i18n/provider'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { getPersonRoleSheet, getPpeCard, listPersonJudgements, listPersonVisits, showJudgements, type PersonRoleSheet, type PpeCard } from './api'
import { currentJudgement, nextVisit, safetyCan, type FitnessState } from './model'
import { EmployeeSafetyView, type SafetySection } from './view/EmployeeSafetyView'

const problemOf = (error: unknown): string => (isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : isApiError(error) && error.kind === 'not_found' ? 'problem.notFound' : 'problem.unavailable')

/**
 * `/w/<company>/people/employees/<id>?tab=safety` (B-W2b-146): each section reads on its own with the person's own right —
 * the role sheet (people.view), PPE (safety.view), the fitness judgement (safety.health.view: the anonymised row only until
 * the person presses Show, which records the view on the API and reads the next visit with it; Hide forgets it, and so does
 * leaving the tab: the values live in this component's state alone). Incidents of one person are not served by the API.
 */
export function EmployeeSafety({ employeeId }: { employeeId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => safetyCan(session.permissions), [session.permissions])
  const [roleSheet, setRoleSheet] = useState<SafetySection<PersonRoleSheet>>(can.roleSheet ? { status: 'loading' } : { status: 'restricted' })
  const [ppe, setPpe] = useState<SafetySection<PpeCard>>(can.ppe ? { status: 'loading' } : { status: 'restricted' })
  const [fitness, setFitness] = useState<FitnessState>(can.health ? { status: 'loading' } : { status: 'restricted' })

  const readRole = useCallback(() => {
    if (!can.roleSheet) return
    setRoleSheet({ status: 'loading' })
    getPersonRoleSheet(api, employeeId).then(
      (value) => setRoleSheet({ status: 'ready', value }),
      (error: unknown) => setRoleSheet({ status: 'error', problem: problemOf(error) }),
    )
  }, [api, can.roleSheet, employeeId])

  const readPpe = useCallback(() => {
    if (!can.ppe) return
    setPpe({ status: 'loading' })
    getPpeCard(api, employeeId).then(
      (value) => setPpe({ status: 'ready', value }),
      (error: unknown) => setPpe({ status: 'error', problem: problemOf(error) }),
    )
  }, [api, can.ppe, employeeId])

  // The anonymised judgement only (ids, days, states): nothing is recorded until Show.
  const readFitness = useCallback(() => {
    if (!can.health) return
    setFitness({ status: 'loading' })
    listPersonJudgements(api, employeeId).then(
      (answer) => {
        const judgement = currentJudgement(answer.judgements)
        setFitness(judgement ? { status: 'hidden', judgement } : { status: 'none' })
      },
      (error: unknown) => setFitness({ status: 'error', problem: problemOf(error) }),
    )
  }, [api, can.health, employeeId])

  useEffect(() => {
    readRole()
    readPpe()
    readFitness()
  }, [readRole, readPpe, readFitness])

  const show = () => {
    if (fitness.status !== 'hidden' && fitness.status !== 'failed') return
    const judgement = fitness.judgement
    setFitness({ status: 'opening', judgement })
    Promise.all([showJudgements(api, [judgement.id]), listPersonVisits(api, employeeId)]).then(
      ([values, visits]) => {
        const shown = values.judgements.find((entry) => entry.id === judgement.id)
        setFitness(shown ? { status: 'shown', judgement: shown, next: nextVisit(visits.visits), recordedAt: formatDateTime(new Date().toISOString(), { locale, timeZone: 'Europe/Rome' }) } : { status: 'failed', judgement })
      },
      () => setFitness({ status: 'failed', judgement }),
    )
  }

  const hide = () => {
    // Forgets the values: the next Show is a new read and a new recorded view.
    if (fitness.status === 'shown') readFitness()
  }

  return (
    <EmployeeSafetyView
      model={{
        can,
        employeeId,
        roleSheet,
        ppe,
        fitness,
        issueHref: OFFICE_PAGES.has('/plant/ppe') ? `${prefix}/plant/ppe?issue=${encodeURIComponent(employeeId)}` : null,
        riskHref: OFFICE_PAGES.has('/plant/risk') ? `${prefix}/plant/risk` : null,
        incidentsHref: OFFICE_PAGES.has('/plant/incidents') ? `${prefix}/plant/incidents` : null,
      }}
      actions={{
        onRetry: (section) => (section === 'roleSheet' ? readRole() : section === 'ppe' ? readPpe() : readFitness()),
        onShowFitness: show,
        onHideFitness: hide,
      }}
    />
  )
}
