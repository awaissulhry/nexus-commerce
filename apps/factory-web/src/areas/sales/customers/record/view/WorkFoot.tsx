'use client'

import Link from 'next/link'
import { useT } from '../../../../../lib/i18n/provider'
import { NAMESPACE as SHEET_NS } from '../../../orders/list/sheet/model'
import type { FootWords, WorkFootLine } from '../urgency-foot'
import './work-foot.css'

/**
 * F-CW-302 (10-design §3.6; lead settle S35) — the Work tab's foot: ONE quiet line under the sheet, host-only (Sales › Orders and
 * Made to measure draw none). "Most urgent first (our priority, then Seed Racing's urgent order, then promise date). Orders that
 * left production follow, newest first. Customer urgency: 3 of at most 3 urgent now." — while the customer's switch is off:
 * "… Customer urgency is off for Seed Racing · Portal settings ›" (the door only for a reader who may change it). Under another
 * sort: "Sorted: Newest first." Office words only: the customer never sees our priority or this line. Draws its model.
 */
export function WorkFoot({ line }: { line: WorkFootLine }) {
  const t = useT('parties')
  const s = useT(SHEET_NS)
  const say = (words: FootWords): string => (words.ns === 'sheet' ? s(words.key, words.params) : t(words.key, words.params))
  // T.0: orders at more than one company — each company's own numbers, joined into the one sentence.
  const sayUrgency = (words: FootWords): string => (line.each.length > 0 ? t(words.key, { companies: line.each.map(say).join(' · ') }) : say(words))
  if (!line.urgent && !line.sorted && !line.urgency) return null
  return (
    <p className="fw-cw-foot">
      {line.urgent && (
        <>
          <b>{s('sort.urgent')}</b> {say(line.urgent.rule)}. {say(line.urgent.after)}
        </>
      )}
      {line.sorted && say(line.sorted)}
      {line.urgency && (
        <>
          {' '}
          {sayUrgency(line.urgency)}
          {line.portalHref ? (
            <>
              {' · '}
              <Link href={line.portalHref}>{t('customers.tab.portal')} ›</Link>
            </>
          ) : (
            line.urgency.key === 'customers.work.foot.off' && '.'
          )}
        </>
      )}
    </p>
  )
}
