'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useSheetImport } from '../../../products/styles/import/sheet-import'
import { importMissing, startLeaving, type MissingEmployee } from '../../_shared/api'
import { problemOf, TIME_ZONE, todayIn, type PeopleCan } from '../../_shared/model'
import { MissingPanel, type MissingModel } from './view/MissingPanel'

/**
 * Import employees (design people.employees pop:import "Upload the payroll provider's export or a CSV → column mapping →
 * dry run → diff: new · changed · refused (reasons) · 'In Nexus but not in the file: 3 — mark as leaving?' → Apply →
 * JobProgress → download refused rows"): the ONE import wizard of Admin › Import & export on the employees importer
 * (`people.employees`, keyed by the employee code; one company's records: the job is this company's), through the shared
 * sheet import (products/styles/import/sheet-import.ts). Once its dry run is read, the people of this company that the
 * file does not have (`GET /people/employees/import/:jobId/missing`) are offered their leaver steps, one command each,
 * from the page (the wizard keeps its dialog).
 */
export function EmployeesImport({ open, companyId, prefix, can, onClose, onApplied }: { open: boolean; companyId: string | null; prefix: string; can: PeopleCan; onClose: () => void; onApplied: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const rights = useMemo(() => ({ view: session.permissions.includes('imports.view'), run: can.runImport, apply: can.applyImport, people: false }), [session.permissions, can.runImport, can.applyImport])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const sheet = useSheetImport(api, {
    importerKey: 'people.employees',
    companyId: companyId ?? '',
    companies,
    everyCompany: '—',
    rights,
    locale: locale === 'en' ? 'en' : 'it',
    onApplied,
  })
  const opened = useRef(false)
  useEffect(() => {
    if (open && !opened.current) {
      opened.current = true
      sheet.open()
    }
    if (!open) opened.current = false
  }, [open, sheet])
  // The wizard closed itself (Close, Esc): the address forgets `?import=1`.
  const wizardOpen = sheet.model !== null
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !wizardOpen && open) onClose()
    wasOpen.current = wizardOpen
  }, [wizardOpen, open, onClose])

  // ---- "In Nexus but not in the file" ---------------------------------------------------------------------------------------
  const job = sheet.model?.wizard.job ?? null
  const read = job && ['PLANNED', 'APPLYING', 'APPLIED'].includes(job.status) ? job.id : null
  const [missing, setMissing] = useState<MissingModel | null>(null)
  useEffect(() => {
    if (!read) return
    let live = true
    importMissing(api, read)
      .then((answer) => live && setMissing({ jobId: read, people: answer.missing, lastWorkingDay: todayIn(TIME_ZONE), busy: false, done: 0, refused: [] }))
      .catch(() => live && setMissing(null))
    return () => {
      live = false
    }
  }, [api, read])

  const startAll = useCallback(async () => {
    if (!missing || missing.busy) return
    setMissing({ ...missing, busy: true, refused: [] })
    const refused: Array<{ person: MissingEmployee; words: ReturnType<typeof problemOf> }> = []
    let done = 0
    for (const person of missing.people.filter((entry) => !entry.leaving)) {
      try {
        await startLeaving(api, person.id, { lastWorkingDay: missing.lastWorkingDay })
        done += 1
      } catch (error) {
        refused.push({ person, words: problemOf(error) })
      }
    }
    onApplied()
    setMissing((current) => (current ? { ...current, busy: false, done: current.done + done, refused, people: current.people.map((entry) => (refused.some((r) => r.person.id === entry.id) ? entry : { ...entry, leaving: true })) } : current))
  }, [api, missing, onApplied])

  return (
    <MissingPanel
      sheet={sheet.model}
      sheetActions={sheet.actions}
      missing={missing}
      can={can}
      prefix={prefix}
      onDay={(lastWorkingDay) => setMissing((current) => (current ? { ...current, lastWorkingDay } : current))}
      onStart={() => void startAll()}
      onDismiss={() => setMissing(null)}
    />
  )
}
