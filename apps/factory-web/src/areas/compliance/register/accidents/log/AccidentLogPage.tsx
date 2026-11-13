'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../../../lib/i18n/provider'
import { romeToday } from '../../../../../lib/safety-reports/intake'
import { companyPrefix } from '../../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { csvLine, downloadText, liveMatches, useLive } from '../../../../quality/_shared/hooks'
import { accidentLog, type AccidentLog, type LogEntry } from '../api'
import { logAddressOf, logApiQuery, logQuery, NS, readProblemOf, reportHref, safetyCan, type LogAddress } from '../model'
import { SafetyMessages } from '../parts'
import { AccidentLogView } from './view/AccidentLogView'

const LIVE_TYPES = ['safety_report.', 'accident_log.revised']

/**
 * `/w/<company>/compliance/register/accidents` — the accident log (SCR-422, B-W2b-357 on B-W2b-351's `GET
 * /sales/safety-reports/accident-log`): reads the log with the address's filters (`?view=toTell&told=&outcome=&from=&to=`),
 * keeps them in the address, tells of changes on the live stream ("N updates · Show": rows never move under the pointer),
 * copies the selection's numbers and exports it as CSV (no injury, no reporter: the log has none). A row opens its report.
 */
export function AccidentLogPage() {
  return (
    <SafetyMessages>
      <LogContainer />
    </SafetyMessages>
  )
}

function LogContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const t = useT(NS)
  const can = useMemo(() => safetyCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const address = useMemo(() => logAddressOf(params), [params])
  const [read, setRead] = useState<{ items: readonly LogEntry[] | null; problem: string | null; log: AccidentLog | null }>({ items: null, problem: null, log: null })
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const reading = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const log = await accidentLog(api, logApiQuery(address), control.signal)
      if (control.signal.aborted) return
      setRead({ items: log.entries, problem: null, log })
      setUpdates(0)
      setSelected((current) => current.filter((id) => log.entries.some((entry) => entry.reportId === id)))
    } catch (error) {
      if (control.signal.aborted) return
      setRead((current) => ({ ...current, items: null, problem: readProblemOf(error) }))
    }
  }, [api, address, can.view])

  useEffect(() => {
    void load()
    return () => reading.current?.abort()
  }, [load])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE_TYPES)) setUpdates((count) => count + 1)
    },
    () => setUpdates((count) => count + 1),
  )

  const go = (next: LogAddress) => router.replace(`${pathname}${logQuery(next)}`, { scroll: false })

  return (
    <AccidentLogView
      model={{ prefix, can, address, rows: { items: read.items, problem: read.problem }, tiles: read.log?.tiles ?? null, asOf: read.log?.asOf ?? null, live, updates, today: romeToday(), selected }}
      actions={{
        onAddress: (patch) => go({ ...address, ...patch }),
        onClear: () => go({ from: null, to: null, outcome: null, told: null, toTell: false }),
        onRetry: () => {
          setRead((current) => ({ ...current, problem: null }))
          void load()
        },
        onShowUpdates: () => void load(),
        onOpen: (entry) => router.push(reportHref(prefix, entry.reportId, 'accident')),
        onSelect: setSelected,
        onCopy: (numbers) => void navigator.clipboard?.writeText(numbers.join('\n')),
        onExport: (rows) =>
          downloadText(
            `${t('log.fileName')}.csv`,
            [
              csvLine([t('log.col.report'), t('log.col.day'), t('log.col.place'), t('log.col.product'), t('log.csv.serial'), t('log.csv.batch'), t('log.col.outcome'), t('log.csv.toldOn'), t('log.csv.reference'), t('log.col.revisions')]),
              ...rows.map((row) => csvLine([row.number, row.occurredOn, row.place, row.style?.code ?? '', row.serial, row.batchNumber, t(`outcome.${row.outcome}`), row.authority?.toldAt.slice(0, 10) ?? '', row.authority?.reference ?? '', row.revisions])),
            ].join('\n'),
          ),
      }}
    />
  )
}
