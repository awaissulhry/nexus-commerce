'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import type { Translate } from '../../../../../lib/i18n/messages'
import { Section } from '../../../../quality/_shared/parts'
import { garmentOf, type Words } from '../../model'
import type { RmaModel } from '../../view-model'
import { Money, say, useDayWords, useWords } from '../../view/parts'
import type { ReturnDepth } from '../api'
import { approverWords, arrivalTone, arrivalWords, creditHeldKey, creditStateOf, feeWords, policyWords, remakePhotoWords, splitHeldKey, windowWords } from '../model'
import type { RmaDepthActions, RmaDepthModel } from '../view-model'

/**
 * The W2b parts of a return's record (B-W2b-352; design sales.returns › Return (RMA)), each drawn from `RmaDepthModel`:
 * the facts the depth adds (the policy, the goods against their deadline, the consumer's withdrawal, the scan code), the
 * notices (a policy not bound yet, a newer policy, the remake asked — its decision is the made-to-measure office's, later),
 * on Inspection & decision each line's split, size exchange and the fee a drafted decision withholds, and on Replacement &
 * credit "Credit without return" (within the approval limit: done at once, or waiting for a yes) and "Restocking or
 * handling fee" (dropped when the cause is ours). Every held button says why. Money only with the price grain. Fetches
 * nothing.
 */

/** The facts the depth adds to the record's KeyValue (each in words). */
export function depthFacts(t: Translate, dayWords: (value: string) => string, model: RmaDepthModel): { label: string; value: ReactNode }[] {
  const depth = model.depth.value
  if (!depth) return [{ label: t('depth:fact.policy'), value: model.depth.problem ? <span className="fw-q-hint">{t('depth:read.failed')}</span> : <Spinner size={12} /> }]
  const arrival = say(t, arrivalWords(depth), dayWords)
  return [
    { label: t('depth:fact.policy'), value: say(t, policyWords(depth)) },
    { label: t('depth:fact.arrival'), value: arrivalTone(depth) === 'warning' ? <Pill tone="warning">{arrival}</Pill> : arrival },
    ...(depth.channel === 'CONSUMER_DISTANCE' ? [{ label: t('depth:fact.withdrawal'), value: t(depth.policy.withdrawal ? 'depth:withdrawal.yes' : 'depth:withdrawal.no') }] : []),
    { label: t('depth:fact.scanCode'), value: depth.scanCode ? <span className="fw-q-code">{depth.scanCode}</span> : t('depth:scanCode.none') },
  ]
}

/** The notices of the depth (each a sentence): a policy not bound yet, a newer policy than the one named. */
function depthNotes(depth: ReturnDepth | null): Words[] {
  if (!depth) return []
  const out: Words[] = []
  if (depth.policy.named && !depth.policy.current && depth.policy.live) out.push({ key: 'depth:policy.newer', params: { name: depth.policy.live.name } })
  if (!depth.policy.named && depth.policy.live && depth.status === 'AUTHORISED') out.push({ key: 'depth:policy.notBound', params: { name: depth.policy.live.name } })
  return out
}

/** Above the tabs: the depth's notices and the remake asked on this return (by the customer or the office). */
export function DepthNotices({ model, depthModel }: { model: RmaModel; depthModel: RmaDepthModel }) {
  const t = useWords()
  const dayWords = useDayWords()
  const outcomes = depthModel.outcomes.value
  const notes = depthNotes(depthModel.depth.value)
  const remake = outcomes?.remake.asked ? outcomes.remake : null
  return (
    <>
      {notes.map((words) => (
        <Banner key={words.key} tone="info" title={say(t, words)} />
      ))}
      {remake && outcomes && (
        <Banner tone="info" title={t('depth:remake.title', { via: t(`depth:remake.via.${remake.via ?? 'OFFICE'}`), date: remake.at ? dayWords(remake.at.slice(0, 10)) : '—' })}>
          <ul className="fw-q-lines">
            <li>{t('depth:remake.lines', { lines: outcomes.lines.filter((line) => remake.lineIds.includes(line.id)).map((line) => line.seq).join(', ') || '—' })}</li>
            {remake.fit && <li>{t('depth:remake.fit', { fit: remake.fit })}</li>}
            {remakePhotoWords(outcomes).map((words, index) => (
              <li key={index}>{say(t, words)}</li>
            ))}
            <li className="fw-q-hint">{t(model.rma.lines.some((line) => remake.lineIds.includes(line.id) && line.receivedQuantity > 0) ? 'depth:remake.decideLater' : 'depth:remake.later')}</li>
          </ul>
        </Banner>
      )}
    </>
  )
}

/**
 * Inspection & decision › one line's W2b part: what the line is now (exchanged for a size, split, credited without the goods,
 * outside its window), the fee its drafted decision would withhold (or why none), and Split the rest (the pieces that did
 * not arrive become their own line, still expected).
 */
export function LineDepth({ lineId, model, depthModel, actions }: { lineId: string; model: RmaModel; depthModel: RmaDepthModel; actions?: RmaDepthActions }) {
  const t = useWords()
  const dayWords = useDayWords()
  const { rma, can } = model
  const outcomes = depthModel.outcomes.value
  const line = outcomes?.lines.find((entry) => entry.id === lineId) ?? null
  const depthLine = depthModel.depth.value?.lines.find((entry) => entry.id === lineId) ?? null
  const fee = depthModel.fees?.lines.find((entry) => entry.lineId === lineId) ?? null
  const seqOf = (id: string) => outcomes?.lines.find((entry) => entry.id === id)?.seq ?? '—'
  const notes: string[] = []
  if (line?.exchangeSize) notes.push(t('depth:exchange.decided', { from: line.size ?? '—', to: line.exchangeSize }))
  if (line?.parentLineId) notes.push(t('depth:split.child', { seq: seqOf(line.parentLineId) }))
  if (line && line.splitLineIds.length > 0) notes.push(t('depth:split.parent', { seqs: line.splitLineIds.map(seqOf).join(', ') }))
  if (line?.creditWithoutReturn) notes.push(t('depth:credit.state.credited'))
  const window = windowWords(depthLine?.window ?? null)
  if (window) notes.push(say(t, window, dayWords))
  const showSplit = line !== null && line.receivedQuantity > 0 && line.receivedQuantity < line.quantity && !line.creditWithoutReturn
  const splitHeld = !can.receive ? { key: 'held.right.receive' } : model.offline ? { key: 'held.offline' } : line ? splitHeldKey(rma.status, line) : null
  return (
    <>
      {notes.length > 0 && <p className="fw-q-hint">{notes.join(' · ')}</p>}
      {fee && (
        <p className="fw-q-hint" aria-live="polite">
          {fee.fee ? (
            fee.fee.dropped ? (
              t(`depth:fee.dropped.${fee.fee.dropped}`, { rule: fee.fee.ruleName })
            ) : (
              <>
                {t('depth:fee.draft', { rule: fee.fee.ruleName })} {can.price && <Money minor={fee.fee.amount ?? null} currency={fee.currency} />}
                {can.price && typeof fee.creditAfter === 'number' && (
                  <>
                    {' · '}
                    {t('depth:fee.creditAfter')} <Money minor={fee.creditAfter} currency={fee.currency} />
                  </>
                )}
              </>
            )
          ) : (
            t('depth:fee.noRule')
          )}
        </p>
      )}
      {showSplit && line && (
        <span className="fw-q-actions">
          <Button size="sm" heldReason={splitHeld ? say(t, splitHeld) : null} onClick={() => actions?.onDepthDialog?.({ kind: 'split', lineId })}>
            {t('depth:split.open', { count: line.split.rest || line.quantity - line.receivedQuantity })}
          </Button>
        </span>
      )}
    </>
  )
}

/** Replacement & credit › Credit without return: each line none of whose pieces came, credited, waiting, or held with why. */
export function CreditWithoutReturnSection({ model, depthModel, actions }: { model: RmaModel; depthModel: RmaDepthModel; actions?: RmaDepthActions }) {
  const t = useWords()
  const { rma, can, prefix } = model
  const depth = depthModel.depth.value
  if (!depth)
    return (
      <Section title={t('depth:credit.title')} sub={t('depth:credit.sub')}>
        {depthModel.depth.problem ? <ReadFailed actions={actions} /> : <Loading />}
      </Section>
    )
  const rows = depth.lines.map((line) => {
    const w2a = rma.lines.find((entry) => entry.id === line.id)
    const decided = (w2a?.disposition ?? null) !== null
    return { line, w2a, state: creditStateOf(line), held: creditHeldKey(rma.status, { ...line, decided }, can, model.offline) }
  })
  return (
    <Section title={t('depth:credit.title')} sub={t('depth:credit.sub')}>
      {rows.length === 0 ? (
        <p className="fw-q-hint">{t('lines.empty')}</p>
      ) : (
        <SummaryTable
          label={t('depth:credit.title')}
          columns={[t('line.col.line'), t('line.col.garment'), ...(can.price ? [t('depth:credit.col.value')] : []), t('depth:credit.col.state'), t('col.actions')]}
          rows={rows.map(({ line, w2a, state, held }) => ({
            id: line.id,
            cells: [
              <span key="s" className="fw-q-num">
                {line.seq}
              </span>,
              w2a ? garmentOf(w2a) || w2a.description : '—',
              ...(can.price ? [<Money key="v" minor={line.value ?? null} currency={line.currency} />] : []),
              <span key="st" className="fw-q-cell">
                <span>{t(`depth:credit.state.${state}`)}</span>
                {state === 'waiting' && line.creditWithoutReturn.waiting ? (
                  <span className="fw-q-hint">
                    {say(t, approverWords(line.creditWithoutReturn.waiting, model.people))} ·{' '}
                    <Link className="fw-q-link" href={`${prefix}/home/approvals`}>
                      {t('depth:credit.openRequest')}
                    </Link>
                  </span>
                ) : state === 'credited' && can.price ? (
                  <span className="fw-q-hint">
                    <Money minor={line.creditAmount ?? null} currency={line.currency} />
                  </span>
                ) : state === 'held' && held ? (
                  <span className="fw-q-hint">{say(t, held)}</span>
                ) : null}
              </span>,
              state === 'credited' || state === 'waiting' ? (
                <span key="a" className="fw-q-hint">
                  —
                </span>
              ) : (
                <Button key="a" size="sm" heldReason={held ? say(t, held) : null} onClick={() => actions?.onDepthDialog?.({ kind: 'credit', draft: { lineId: line.id, amount: '', note: '' }, preview: null, previewing: true })}>
                  {t('depth:credit.open', { seq: line.seq })}
                </Button>
              ),
            ],
          }))}
          stackOnPhone
        />
      )}
      <p className="fw-q-hint">{t('depth:credit.limit')}</p>
    </Section>
  )
}

/** Replacement & credit › Restocking or handling fee: the rule each decided line took, its amount, or why it was dropped. */
export function FeeSection({ model, depthModel, actions }: { model: RmaModel; depthModel: RmaDepthModel; actions?: RmaDepthActions }) {
  const t = useWords()
  const { rma, can } = model
  const depth = depthModel.depth.value
  if (!depth)
    return (
      <Section title={t('depth:fee.title')} sub={t('depth:fee.sub')}>
        {depthModel.depth.problem ? <ReadFailed actions={actions} /> : <Loading />}
      </Section>
    )
  return (
    <Section title={t('depth:fee.title')} sub={t('depth:fee.sub')}>
      {!depth.feesApply ? (
        <p className="fw-q-hint">{t('depth:fee.noPolicy')}</p>
      ) : (
        <SummaryTable
          label={t('depth:fee.title')}
          columns={[t('line.col.line'), t('depth:fee.col.rule'), ...(can.price ? [t('depth:fee.col.amount')] : [])]}
          rows={depth.lines.map((line) => {
            const decided = (rma.lines.find((entry) => entry.id === line.id)?.disposition ?? null) !== null
            return {
              id: line.id,
              cells: [
                <span key="s" className="fw-q-num">
                  {line.seq}
                </span>,
                say(t, feeWords(line.fee, { feesApply: depth.feesApply, decided })),
                ...(can.price ? [line.fee && !line.fee.dropped ? <Money key="a" minor={line.fee.amount ?? null} currency={line.currency} /> : <span key="a" className="fw-q-hint">—</span>] : []),
              ],
            }
          })}
          stackOnPhone
        />
      )}
      <p className="fw-q-hint">{t('depth:fee.ours')}</p>
    </Section>
  )
}

function Loading() {
  const t = useWords()
  return (
    <p className="fw-q-loading" role="status">
      <Spinner size={12} /> {t('quality:common.loading')}
    </p>
  )
}

function ReadFailed({ actions }: { actions?: RmaDepthActions }) {
  const t = useWords()
  return (
    <Banner
      tone="warning"
      title={t('depth:read.failed')}
      action={
        <Button size="sm" onClick={() => actions?.onDepthRetry?.()}>
          {t('quality:common.retry')}
        </Button>
      }
    />
  )
}
