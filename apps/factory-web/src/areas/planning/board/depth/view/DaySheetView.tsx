'use client'

import { useMemo } from 'react'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { DaySheetPaper } from '../api'
import { DEPTH_NAMESPACE } from '../model'
import { DaySheetPreview } from './DaySheetPreview'
import '../../board.css'
import '../depth.css'

/** SCR-407: the day sheets' paper as a page of its own (the design route; the print dialog shows the same preview). */
export function DaySheetView({ model }: { model: DaySheetPaper }) {
  return (
    <WithMessages namespaces={[DEPTH_NAMESPACE]}>
      <Body paper={model} />
    </WithMessages>
  )
}

function Body({ paper }: { paper: DaySheetPaper }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const words = useMemo(() => ({ t, locale, timeZone: 'Europe/Rome' }), [t, locale])
  return (
    <div className="fw-pb">
      <h1 className="fw-pbd-h1">{paper.title}</h1>
      <DaySheetPreview paper={paper} words={words} open />
    </div>
  )
}

