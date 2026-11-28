'use client'

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { fixedDepartments, type DepartmentAnswer } from '../../../../lib/department/model'
import { keptDepartments, resetDepartments, wantDepartments } from '../../../../lib/department/use-departments'
import { useDepartmentWords } from '../../../../lib/department/words'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { mayManage } from '../../styles/routing/builder/manage'
import { lineBody, refusalOf, type BuilderState } from '../../styles/routing/builder/model'
import { RouteBuilderWindow, type BuilderOpen } from '../../styles/routing/builder/RouteBuilderWindow'
import { dropLineException, pickLineRoute, putLineException, readLineRoutes, type LineRoute, type LineRoutes } from '../../styles/routing/line/api'
import { answerOfLines, exceptionStartOf, lineMayOf, lineRowsOf, readProblemKeyOf } from '../../styles/routing/line/model'
import { LineRoutesView, type LineRoutesViewModel } from '../../styles/routing/line/view/LineRoutesView'
import { deptLooksOf, type Words } from '../../styles/routing/route/model'
import { useOfficeReach } from '../../styles/routing/route/office'

/**
 * SLOT — owner: S4 (owb-pd6); filled by pd6 step 6.4 (the part "Route of each line": each line's steps as a DeptBar, where it comes from, the pick and the exception route).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: MOUNTED by the base
 * in the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx), after Team. Office only: the customer
 * never reaches it.
 *
 * owb-pd6 step 6.4 (design plan § 5v, § 5z): `GET /sales/orders/:orderId/line-routes` — each line with its route as the department bar
 * and where it comes from (From the product · Model · For this customer · Order structure · Only this order); sales (`may.pick`) picks a
 * model route (`PUT …/lines/:lineId/route`); the production manager (`may.exception`) opens the route builder in line mode, "Why is this
 * order different?" required (`PUT …/route-exception`), or goes "Back to the normal route" (`DELETE …/route-exception`). `frozen` (the
 * basket cards are printed): read only, "Fixed at the print of the basket cards". Outside the office layout (the design index, a
 * test's render of the tab) it draws nothing, as before it was filled. Words: `products-route` (brought here).
 */
export interface RouteOfEachLinePartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function RouteOfEachLinePart({ companyId, orderId }: RouteOfEachLinePartProps): ReactElement | null {
  const { api, can } = useOfficeReach()
  if (!api) return null
  return (
    <WithMessages namespaces={['products-route']}>
      <LineRoutesPart api={api} manage={mayManage(can)} companyId={companyId} orderId={orderId} />
    </WithMessages>
  )
}

type Read = { status: 'reading' } | { status: 'ready'; answer: LineRoutes } | { status: 'failed'; problem: string }

function LineRoutesPart({ api, manage, companyId, orderId }: { api: ApiClient; manage: boolean; companyId: string; orderId: string }): ReactElement {
  const t = useT('products-route')
  const sayDept = useDepartmentWords()
  const locale = useLocale()
  const fixed = useMemo(() => fixedDepartments(sayDept), [sayDept])
  const [read, setRead] = useState<Read>({ status: 'reading' })
  const [rows, setRows] = useState<readonly DepartmentAnswer[] | null>(() => keptDepartments() ?? null)
  const [deptState, setDeptState] = useState<'ready' | 'reading' | 'failed'>(() => (keptDepartments() ? 'ready' : 'reading'))
  const [round, setRound] = useState(0)
  const again = useCallback(() => setRound((value) => value + 1), [])
  const [busyLine, setBusyLine] = useState<string | null>(null)
  const [actProblem, setActProblem] = useState<Words | null>(null)
  const [builder, setBuilder] = useState<{ readonly open: BuilderOpen; readonly line: LineRoute } | null>(null)

  useEffect(() => {
    const control = new AbortController()
    readLineRoutes(api, orderId, control.signal).then(
      (answer) => setRead({ status: 'ready', answer }),
      (error: unknown) => {
        if (!control.signal.aborted) setRead({ status: 'failed', problem: readProblemKeyOf(error) })
      },
    )
    return () => control.abort()
  }, [api, orderId, round])

  useEffect(() => {
    let live = true
    wantDepartments(api).then(
      (answer) => {
        if (!live) return
        setRows(answer)
        setDeptState('ready')
      },
      () => {
        if (live) setDeptState((state) => (state === 'ready' ? state : 'failed'))
      },
    )
    return () => {
      live = false
    }
  }, [api, round])

  const looks = useMemo(() => deptLooksOf(rows ?? [], locale), [rows, locale])
  const answer = read.status === 'ready' ? read.answer : null
  const lineOf = (lineId: string) => answer?.lines.find((line) => line.lineId === lineId) ?? null

  /** One write on a line: its controls wait, the routes are read again after it, a refusal is said in words. */
  const act = async (lineId: string, write: () => Promise<unknown>) => {
    if (busyLine) return
    setBusyLine(lineId)
    setActProblem(null)
    try {
      await write()
    } catch (error) {
      setActProblem(refusalOf(error))
    } finally {
      setBusyLine(null)
      again()
    }
  }

  const pick = (lineId: string, routeId: string | null) => {
    const line = lineOf(lineId)
    if (!line || !answer || !lineMayOf(answer, line).pick) return
    void act(lineId, () => pickLineRoute(api, orderId, line, routeId))
  }
  const back = (lineId: string) => {
    const line = lineOf(lineId)
    if (!line || !answer || !lineMayOf(answer, line).back) return
    void act(lineId, () => dropLineException(api, orderId, line))
  }
  const exception = (lineId: string) => {
    const line = lineOf(lineId)
    if (!line || !answer || !lineMayOf(answer, line).exception || !rows) return
    const product = line.product ? `${line.product.code} ${line.product.name}` : ''
    setBuilder({ line, open: { mode: 'line', subtitle: t('builder.subtitle.line', { line: line.seq, product }), start: exceptionStartOf(line) } })
  }
  const saveLine = async (state: BuilderState): Promise<Words | null> => {
    if (!builder) return { key: 'problem.unavailable' }
    try {
      await putLineException(api, orderId, builder.line.lineId, lineBody(state, builder.line.version ?? null))
      setBuilder(null)
      again()
      return null
    } catch (error) {
      // The line moved meanwhile (another person, the print): read again; the window says why.
      if ((error as { kind?: string } | null)?.kind === 'conflict') again()
      return refusalOf(error)
    }
  }

  const model: LineRoutesViewModel = {
    state: read.status === 'ready' ? 'ready' : read.status === 'failed' ? 'failed' : 'reading',
    problem: read.status === 'failed' ? read.problem : null,
    answer: answer ? answerOfLines(answer) : null,
    rows: answer ? lineRowsOf(answer, looks, fixed, (no) => sayDept('unknown', { no })) : [],
    busyLine,
    exceptionHeld: rows ? null : { key: deptState === 'failed' ? 'held.departmentsFailed' : 'held.departmentsReading' },
    actProblem,
  }

  return (
    <>
      <LineRoutesView model={model} actions={{ onPick: pick, onException: exception, onBack: back, onRetry: again }} />
      {builder && rows && (
        <RouteBuilderWindow
          api={api}
          open={builder.open}
          departments={rows}
          companyId={companyId}
          onSave={saveLine}
          onClose={() => setBuilder(null)}
          mayManage={manage}
          onDepartments={(next) => {
            resetDepartments()
            setRows(next)
          }}
        />
      )}
    </>
  )
}
