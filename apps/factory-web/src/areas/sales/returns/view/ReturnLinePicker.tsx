'use client'

import { Field } from '@nexus/ui/components'
import { Input, Select } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import type { ReasonOption, ReturnableLine } from '../api'
import { outsideWindow, returnableKey, type NewReturnLineDraft } from '../model'
import { DayText, Money, useWords } from './parts'

/**
 * The rows of what may come back (design rma.lines "Add lines by picking from the customer's invoiced lines", and New
 * return): per invoiced (or shipped, not invoiced) line what was sold and what is left, the pieces (refused at the field
 * above what is left, with the numbers), the reason from the RETURN list and the customer's words. Shared by New return
 * and the RMA's Add lines (B-W2b-16); `taken` marks the lines already on the RMA (their pieces change on the Lines tab).
 */
export function ReturnLinePicker({
  lines,
  drafts,
  reasons,
  price,
  windowDays,
  today,
  showProblems,
  taken,
  onLine,
}: {
  lines: readonly ReturnableLine[]
  drafts: Readonly<Record<string, NewReturnLineDraft>>
  reasons: readonly ReasonOption[] | null
  price: boolean
  windowDays: number | null
  today: string
  showProblems: boolean
  /** Lines already on the return, by returnable key: their seq. */
  taken?: Readonly<Record<string, number>>
  onLine?: (key: string, patch: Partial<NewReturnLineDraft>) => void
}) {
  const t = useWords()
  const locale = useLocale()
  return (
    <div className="fw-rr-pick">
      {lines.map((line) => {
        const key = returnableKey(line)
        const entry = drafts[key] ?? { quantity: '', reasonCode: '', note: '' }
        const typed = entry.quantity.trim()
        const over = /^\d+$/.test(typed) && Number(typed) > line.left
        const late = outsideWindow(line, windowDays, today)
        const seq = taken?.[key]
        const closed = line.left === 0 || seq !== undefined
        return (
          <div key={key} className="fw-rr-pick-row">
            <span className="fw-q-cell">
              <span className="fw-q-name">{line.description}</span>
              <span className="fw-q-hint fw-q-code">
                {[line.invoice?.number ? t('newReturn.invoice', { number: line.invoice.number, seq: line.invoice.lineSeq }) : null, line.order ? t('newReturn.orderLine', { number: line.order.number, seq: line.order.lineSeq }) : null].filter(Boolean).join(' · ')}
              </span>
              <span className="fw-q-hint">
                {t('newReturn.soldLeft', { sold: line.sold, left: line.left })}
                {price && line.pieceValue !== undefined && line.pieceValue !== null ? ' · ' : ''}
                {price && line.pieceValue !== undefined && line.pieceValue !== null ? <Money minor={line.pieceValue} currency={line.currency} /> : null}
                {line.deliveredOn ? ' · ' : ''}
                {line.deliveredOn ? (
                  <>
                    {t('newReturn.delivered')} <DayText value={line.deliveredOn} />
                  </>
                ) : null}
                {line.ppe ? ` · ${t('newReturn.ppe')}` : ''}
              </span>
              {seq !== undefined && <span className="fw-q-hint">{t('addLines.taken', { seq })}</span>}
              {late !== null && <span className="fw-q-hint">{t('newReturn.outsideWindow', { days: late, window: windowDays ?? 0 })}</span>}
            </span>
            <Field label={t('newReturn.pieces')} error={over ? t('refusal.aboveSoldMax', { max: line.left, sold: line.sold }) : undefined}>
              <Input inputMode="numeric" value={entry.quantity} disabled={closed} placeholder={closed ? '0' : `≤ ${line.left}`} onChange={(event) => onLine?.(key, { quantity: event.target.value })} aria-label={t('newReturn.piecesOf', { line: line.description })} />
            </Field>
            <Field label={t('newReturn.reason')} error={showProblems && typed && typed !== '0' && !entry.reasonCode ? t('newReturn.problem.reasonShort') : undefined}>
              <Select value={entry.reasonCode} disabled={!reasons || closed} onChange={(event) => onLine?.(key, { reasonCode: event.target.value })} aria-label={t('newReturn.reasonOf', { line: line.description })}>
                <option value="">{t('newReturn.pickReason')}</option>
                {(reasons ?? []).map((reason) => (
                  <option key={reason.code} value={reason.code}>
                    {locale === 'it' ? reason.labelIt : reason.labelEn}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('newReturn.reasonNote')}>
              <Input value={entry.note} disabled={closed} onChange={(event) => onLine?.(key, { note: event.target.value })} aria-label={t('newReturn.noteOf', { line: line.description })} />
            </Field>
          </div>
        )
      })}
    </div>
  )
}
