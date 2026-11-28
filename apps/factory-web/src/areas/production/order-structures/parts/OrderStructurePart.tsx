'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { usePathname } from 'next/navigation'
import type { ApiClient } from '../../../../lib/api/client'
import { WithMessages } from '../../../../record-panels/i18n'
import { useOfficeOrNull } from '../../teams/use-office'
import { backToRules, getOrderStructure, getRules, getStructures, putOrderStructure, type OrderStructure, type RuleRow, type StructureRow } from '../api'
import { orderDraftOf, orderHeldOf, orderPartOf, ORDER_STRUCTURES_NS, problemKeyOf, ruleNoOf, rulesOf, type OrderDraft } from '../model'
import { OrderStructurePartView } from '../view/Parts'
import { OrderStructureWindow } from '../view/Windows'

/**
 * SLOT — owner: S3 (owb-ss8); filled by ss8 step 8.4 (the part "Order structure": each line's structure and its rule, Another structure for this order…).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: MOUNTED by the base in
 * the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx), after Materials. Office only: the customer
 * never reaches it.
 *
 * owb-ss8 8.4 (design § 5zj C; prototype rules.js structSec, oplanModal) — reads GET /production/orders/:orderId/structure (owb-ss6) and
 * the rules (their numbers): each line's structure and why, "Kept since the work started" after the first print; before it, with the
 * right (`may.change`), "Another structure for this order…" (a structure or the normal way, with why: PUT) and "Back to the rules"
 * (DELETE). 403/404 (the designer, the floor) → no part; no session (design index, the tab's server-drawn tests) → nothing.
 */
export interface OrderStructurePartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function OrderStructurePart(props: OrderStructurePartProps): ReactElement | null {
  const office = useOfficeOrNull()
  if (!office) return null
  return (
    <WithMessages namespaces={[ORDER_STRUCTURES_NS]}>
      <OrderStructureContainer api={office.api} orderId={props.orderId} />
    </WithMessages>
  )
}

function OrderStructureContainer({ api, orderId }: { api: ApiClient; orderId: string }): ReactElement | null {
  const pathname = usePathname()
  const prefix = pathname.replace(/\/sales\/orders\/.*$/, '')
  const [read, setRead] = useState<{ value: OrderStructure | null; problem: string | null; hidden: boolean }>({ value: null, problem: null, hidden: false })
  const [rules, setRules] = useState<readonly RuleRow[]>([])
  const [structures, setStructures] = useState<readonly StructureRow[] | null>(null)
  const [win, setWin] = useState<{ draft: OrderDraft | null; busy: boolean; problem: string | null }>({ draft: null, busy: false, problem: null })
  const readId = useRef(0)

  const load = useCallback(() => {
    const id = ++readId.current
    getOrderStructure(api, orderId)
      .then((value) => id === readId.current && setRead({ value, problem: null, hidden: false }))
      .catch((error: unknown) => {
        if (id !== readId.current) return
        const problem = problemKeyOf(error, false)
        setRead({ value: null, problem, hidden: problem === 'error.forbidden' || problem === 'error.notFound' })
      })
    getRules(api)
      .then((answer) => id === readId.current && setRules(answer.rules))
      .catch(() => undefined) // without the rules a line says "by a rule" without its number
  }, [api, orderId])
  useEffect(() => load(), [load])

  const open = useMemo(() => rulesOf(rules).open, [rules])
  const ruleNo = useCallback((ruleId: string) => ruleNoOf(open, ruleId), [open])
  const part = useMemo(() => (read.value ? orderPartOf(read.value) : null), [read.value])

  const openWindow = () => {
    if (!read.value) return
    setWin({ draft: orderDraftOf(read.value), busy: false, problem: null })
    if (!structures)
      getStructures(api)
        .then((answer) => setStructures(answer.structures))
        .catch(() => setStructures([]))
  }
  const held = win.draft ? orderHeldOf(win.draft, structures ?? []) : null
  const save = async () => {
    const draft = win.draft
    if (!draft || win.busy || held || draft.structureId === undefined) return
    setWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      const value = await putOrderStructure(api, orderId, { structureId: draft.structureId, why: draft.why.trim() })
      setRead({ value, problem: null, hidden: false })
      setWin({ draft: null, busy: false, problem: null })
    } catch (error) {
      setWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }
  const back = async () => {
    try {
      const value = await backToRules(api, orderId)
      setRead({ value, problem: null, hidden: false })
    } catch (error) {
      setRead((current) => ({ ...current, problem: problemKeyOf(error, true) }))
    }
  }

  if (read.hidden) return null
  return (
    <>
      <OrderStructurePartView
        model={{ state: read.value ? 'ready' : read.problem ? 'failed' : 'reading', problem: read.problem, part, ruleNo, pageHref: `${prefix}/production/order-structures` }}
        actions={{ onChange: openWindow, onBack: () => void back(), onRetry: load }}
      />
      <OrderStructureWindow
        model={{ open: win.draft !== null, read: read.value, draft: win.draft, structures, ruleNo, held, busy: win.busy, problem: win.problem }}
        actions={{
          onClose: () => setWin((current) => (current.busy ? current : { draft: null, busy: false, problem: null })),
          onPick: (structureId) => setWin((current) => (current.draft && !current.busy ? { ...current, draft: { ...current.draft, structureId }, problem: null } : current)),
          onWhy: (why) => setWin((current) => (current.draft && !current.busy ? { ...current, draft: { ...current.draft, why }, problem: null } : current)),
          onSave: () => void save(),
        }}
      />
    </>
  )
}
