'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { readChemical, sheetBytes } from '../api'
import { chemicalsCan, readProblemOf } from '../model'
import { SdsTabView, type SdsTabModel } from './view/SdsTabView'

/**
 * `/w/<company>/plant/chemicals/sds?chemical=<id>&sheet=<id>` (SCR-213-sds, design plant.chemicals/tab:sds "SDS (PDF)",
 * a new tab: "Printable."): one sheet of one chemical, current or superseded, in the DS PdfViewer (its own download and
 * print), with the chemical's name and the sheet's version, day and language. GET /safety/chemicals/:id, then the sheet's
 * bytes read once (safety.view).
 */
export function SdsTab() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const can = useMemo(() => chemicalsCan(session.permissions), [session.permissions])
  const chemicalId = params.get('chemical') ?? ''
  const sheetId = params.get('sheet') ?? ''
  const [model, setModel] = useState<SdsTabModel>({ canView: can.view, chemical: null, sheet: null, pdf: null, problem: null })

  useEffect(() => {
    if (!can.view) return
    let live = true
    setModel({ canView: true, chemical: null, sheet: null, pdf: null, problem: null })
    readChemical(api, chemicalId)
      .then(async (record) => {
        const sheet = record.sheets.find((row) => row.id === sheetId) ?? null
        if (!live) return
        if (!sheet) return setModel({ canView: true, chemical: record.chemical, sheet: null, pdf: null, problem: 'problem.notFound' })
        setModel({ canView: true, chemical: record.chemical, sheet, pdf: null, problem: null })
        const pdf = await sheetBytes(api, record.chemical.id, sheet.id)
        if (live) setModel({ canView: true, chemical: record.chemical, sheet, pdf, problem: null })
      })
      .catch((error: unknown) => live && setModel((current) => ({ ...current, problem: readProblemOf(error) })))
    return () => {
      live = false
    }
  }, [api, can.view, chemicalId, sheetId])

  return <SdsTabView model={{ ...model, canView: can.view }} />
}
