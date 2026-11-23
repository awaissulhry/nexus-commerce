'use client'

import { useEffect, useRef, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { getCustomerUrgency, type CustomerUrgency } from '../../../_shared/customer-urgency/api'
import { useCoalesced } from '../../orders/hooks'

/**
 * F-CW-302 (10-design §3.6; lead settle S35) — the Work tab's foot line, the part about the customer's urgency: "Customer urgency: 3
 * of at most 3 urgent now." or, while the customer's switch is off, "Customer urgency is off for Seed Racing · Portal settings ›".
 *
 * Host-only: ONE read, GET /production/brands/:partyId/urgency (the read the work order's Customer card makes), made ONLY on the
 * customer's Work tab and ONLY with workorders.view — never on Sales › Orders or Made to measure (several customers: no one switch).
 * Without the right, or when the read fails: no urgency part at all (quiet, never an error band, never "0"). The customer never sees
 * this line: it is the office's.
 */

/** The urgency part of the foot line. */
export interface UrgencyFoot {
  /** The customer's switch: off → no customer chip on any row, and the sort has no middle part. */
  readonly on: boolean
  /** The orders the customer marks Urgent now that count (over every company it works with). */
  readonly used: number
  /** The most it may mark (each company's own list has its own quota: their sum). */
  readonly max: number
}

/** The foot's urgency part from the read: a customer at two companies has two urgent lists — their marks and their quotas are summed. */
export function urgencyFootOf(read: Pick<CustomerUrgency, 'urgency' | 'companies'>): UrgencyFoot {
  const used = read.companies.reduce((sum, entry) => sum + entry.use.used, 0)
  const max = read.companies.length > 0 ? read.companies.reduce((sum, entry) => sum + entry.use.max, 0) : read.urgency.max
  return { on: read.urgency.on, used, max }
}

/** A live change after which the part is read again: the customer's urgency changed, or its portal settings (the switch, the quota). */
export const urgencyFootTouched = (type: string): boolean => type === 'brand_production.urgency_changed' || type === 'partner_portal.settings_changed'

/**
 * The foot's urgency part for the customer's Work tab: read only while `enabled` (the Work tab shown AND workorders.view), again on a
 * live change of the urgency or the portal settings (coalesced, 800 ms) and when the live channel comes back. null: not read, no
 * right, or the read failed — the foot then says the sort only.
 */
export function useUrgencyFoot(partyId: string, enabled: boolean): UrgencyFoot | null {
  const api = useOfficeApi()
  const [foot, setFoot] = useState<UrgencyFoot | null>(null)
  const turn = useRef(0)
  const read = useRef<() => void>(() => undefined)
  read.current = () => {
    if (!enabled) return
    const mine = ++turn.current
    getCustomerUrgency(api, partyId).then(
      (value) => mine === turn.current && setFoot(urgencyFootOf(value)),
      () => mine === turn.current && setFoot(null),
    )
  }
  useEffect(() => {
    if (!enabled) {
      turn.current += 1
      setFoot(null)
      return
    }
    read.current()
  }, [api, partyId, enabled])
  const again = useCoalesced(() => read.current(), 800)
  useLiveBus({ onChange: (change) => urgencyFootTouched(change.type) && again(), onReconnect: again }, enabled)
  return foot
}

// ---- the foot line as the tab draws it ------------------------------------------------------------------------------------------------

/** One word of the foot, with the catalogue that says it: the sheet's (`orders-sheet`) or the customer page's (`parties`). */
export interface FootWords {
  readonly ns: 'sheet' | 'parties'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface WorkFootLine {
  /** The sort in bold: "Most urgent first" (with its rule) — or null when another sort is on (then `sorted` says it). */
  readonly urgent: { readonly rule: FootWords; readonly after: FootWords } | null
  /** "Sorted: Newest first." under any other sort. */
  readonly sorted: FootWords | null
  /** "Customer urgency: 3 of at most 3 urgent now." or "Customer urgency is off for Seed Racing" — null: not read (no right, or it failed). */
  readonly urgency: FootWords | null
  /** The ONE quiet door of a switch that is off, only for a reader who may change it: the customer's Portal settings. */
  readonly portalHref: string | null
}

/**
 * The Work tab's foot line (10-design §3.6): the order the rows stand in, said in the reader's words — never "the planning order" —
 * and the customer's urgency state. While the switch is off the rule has no middle part and the line says so, with the door to the
 * customer's Portal settings when the reader may change it there (`mayPortal`).
 */
export function workFootOf(input: { readonly sort: string | null; readonly sortWord: string | null; readonly customer: string; readonly foot: UrgencyFoot | null; readonly portalHref: string; readonly mayPortal: boolean }): WorkFootLine {
  const off = input.foot !== null && !input.foot.on
  const urgent = input.sort === 'urgent' ? { rule: off ? ({ ns: 'sheet', key: 'sort.urgentRuleOff' } as const) : ({ ns: 'sheet', key: 'sort.urgentRule', params: { customer: input.customer } } as const), after: { ns: 'parties', key: 'customers.work.foot.after' } as const } : null
  const sorted = urgent || !input.sortWord ? null : ({ ns: 'parties', key: 'customers.work.foot.sorted', params: { sort: input.sortWord } } as const)
  const urgency: FootWords | null = input.foot === null ? null : off ? { ns: 'parties', key: 'customers.work.foot.off', params: { customer: input.customer } } : { ns: 'parties', key: 'customers.work.foot.use', params: { used: input.foot.used, max: input.foot.max } }
  return { urgent, sorted, urgency, portalHref: off && input.mayPortal ? input.portalHref : null }
}
