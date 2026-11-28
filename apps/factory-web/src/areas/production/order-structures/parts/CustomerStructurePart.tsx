'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { usePathname } from 'next/navigation'
import type { ApiClient } from '../../../../lib/api/client'
import { WithMessages } from '../../../../record-panels/i18n'
import { useOfficeOrNull } from '../../teams/use-office'
import { getCustomerRules, getRules, type CustomerRules, type RuleRow } from '../api'
import { ORDER_STRUCTURES_NS, problemKeyOf, ruleNoOf, rulesOf } from '../model'
import { useRuleWindow } from '../use-rule-window'
import { CustomerStructurePartView } from '../view/Parts'
import { RuleWindow } from '../view/Windows'

/**
 * SLOT — owner: S3 (owb-ss8); filled by ss8 step 8.4 (the customer part "How its orders are handled": the rules that name this customer, New rule for this customer…).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: MOUNTED by the base on
 * the customer page's Terms & requirements tab, last (areas/sales/customers/record/view/terms/TermsTab.tsx). Office only: the customer
 * never reaches it.
 *
 * owb-ss8 8.4 (design § 5zj C; prototype rules.js custStructSec) — reads GET /production/customers/:partyId/structure-rules (owb-ss6) and
 * the whole list (each rule's number): the rules that name this customer, in reading order, with their marks; "New rule for this
 * customer…" opens the rule window with the customer chosen (`may.write`). 403/404 → no part; no session → nothing.
 */
export interface CustomerStructurePartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The customer (Party id). */
  readonly partyId: string
}

export function CustomerStructurePart(props: CustomerStructurePartProps): ReactElement | null {
  const office = useOfficeOrNull()
  if (!office) return null
  return (
    <WithMessages namespaces={[ORDER_STRUCTURES_NS]}>
      <CustomerStructureContainer api={office.api} partyId={props.partyId} />
    </WithMessages>
  )
}

function CustomerStructureContainer({ api, partyId }: { api: ApiClient; partyId: string }): ReactElement | null {
  const pathname = usePathname()
  const prefix = pathname.replace(/\/sales\/customers\/.*$/, '')
  const [read, setRead] = useState<{ value: CustomerRules | null; problem: string | null; hidden: boolean }>({ value: null, problem: null, hidden: false })
  const [all, setAll] = useState<readonly RuleRow[] | null>(null)
  const readId = useRef(0)

  const load = useCallback(() => {
    const id = ++readId.current
    getCustomerRules(api, partyId)
      .then((value) => id === readId.current && setRead({ value, problem: null, hidden: false }))
      .catch((error: unknown) => {
        if (id !== readId.current) return
        const problem = problemKeyOf(error, false)
        setRead({ value: null, problem, hidden: problem === 'error.forbidden' || problem === 'error.notFound' })
      })
    getRules(api)
      .then((answer) => id === readId.current && setAll(answer.rules))
      .catch(() => id === readId.current && setAll(null))
  }, [api, partyId])
  useEffect(() => load(), [load])

  const open = useMemo(() => rulesOf(all ?? []).open, [all])
  const ruleNo = useCallback((ruleId: string) => ruleNoOf(open, ruleId), [open])
  const mine = useMemo(() => rulesOf(read.value?.rules ?? []).open, [read.value])
  const ruleWindow = useRuleWindow(api, { rules: all, onSaved: () => load() })

  if (read.hidden) return null
  return (
    <>
      <CustomerStructurePartView
        model={{ state: read.value ? 'ready' : read.problem ? 'failed' : 'reading', problem: read.problem, rules: mine, ruleNo, write: read.value?.may.write ?? false, pageHref: `${prefix}/production/order-structures` }}
        actions={{ onNewRule: () => ruleWindow.openNew({ partyId }), onEditRule: ruleWindow.openRule, onRetry: load }}
      />
      <RuleWindow model={ruleWindow.model} actions={ruleWindow.actions} />
    </>
  )
}
