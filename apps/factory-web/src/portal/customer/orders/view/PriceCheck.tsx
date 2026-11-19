'use client'

import { Equal, EqualNot, Lock, Minus } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { unitPriceText } from '../model'
import { diffText, matchKey, matchTone, priceCardOf, sourceKey, type PortalPriceCheck, type PriceDraft, type PriceMatch } from '../price-check'
import { useOrderWords } from '../words'

/**
 * F-CP-143 (customer page plan C3, D2, D3; Owner O4; 11 §3.4; review B2, C3; picture 21): the order's "Price check" card on the Lines
 * tab and the "Your prices…" window, for the customer's Buyer, Finance and Admin (the price grain). The card: ONE line — "Our prices
 * agree" · "Our prices differ on {count} lines: change your price (you can add a note)" · "You have not given your price yet" —, how
 * many lines still lack the customer's price, the order's own total check, and "Your prices…" for the Buyer and the Admin while the
 * order is open (held with words otherwise: Finance reads only; a closed order keeps its prices). Never "write to us" (review B2: our
 * production reads the thread). The window: per line our unit price beside the customer's own (a price the factory typed says so and is
 * replaced by typing over it), one note that goes with the prices changed, Save sends the versions read; a 409 says "Someone changed
 * these prices meanwhile. Here they are now.". Anyone without prices never sees this card: "Prices are not part of your access."
 */

export interface PriceDialogModel {
  draft: PriceDraft
  /** By line (keys), and the note's. */
  problems: { lines: Readonly<Record<string, string>>; note: string | null }
  showProblems: boolean
  busy: boolean
  /** A refusal in our words (a key), or null. */
  failed: string | null
  /** The prices changed meanwhile (a 409): the window shows them as they are now. */
  stale: boolean
}

export interface PriceCheckModel {
  state: 'loading' | 'error' | 'ready'
  check: PortalPriceCheck | null
  /** read: Finance, or an order no longer open; write: the Buyer and the Admin. */
  access: 'read' | 'write'
  /** Why "Your prices…" cannot open now (words), or null. */
  held: string | null
  dialog: PriceDialogModel | null
  /** One quiet line after a save ("Your prices are saved."), a key; null: none. */
  notice: string | null
}

export interface PriceCheckActions {
  onOpen?: () => void
  onRetry?: () => void
  dialog?: { onPrice?: (lineId: string, text: string) => void; onNote?: (text: string) => void; onSave?: () => void; onClose?: () => void }
}

const MATCH_ICON = { EQUAL: Equal, NOT_EQUAL: EqualNot, NO_BRAND_PRICE: Minus } as const

/** A check as a DS Tag with its icon and its words (never colour alone). */
export function MatchTag({ match }: { match: PriceMatch | null }) {
  const { t } = useOrderWords()
  const Icon = MATCH_ICON[match ?? 'NO_BRAND_PRICE']
  return (
    <Tag tone={matchTone(match)} className="fw-pord-match">
      <Icon size={12} aria-hidden /> {t(matchKey(match))}
    </Tag>
  )
}

export function PriceCheckCard({ model, actions }: { model: PriceCheckModel; actions?: PriceCheckActions }) {
  const words = useOrderWords()
  const { t } = words
  const check = model.check
  const button =
    model.access === 'write' ? (
      <Button size="sm" variant="secondary" heldReason={model.held} onClick={() => actions?.onOpen?.()}>
        {t('priceCheck.edit')}
      </Button>
    ) : null
  return (
    <Card padded>
      <section className="fw-pord-pricecheck" id="price-check" tabIndex={-1} aria-labelledby="fw-pord-pricecheck-title">
        <div className="fw-pord-pricecheck-head">
          <h2 id="fw-pord-pricecheck-title" className="fw-pord-h2">
            {t('priceCheck.title')}
          </h2>
          {button}
        </div>
        {model.state === 'loading' ? (
          <div role="status" aria-busy="true" aria-label={t('priceCheck.title')}>
            <Skeleton height={40} />
          </div>
        ) : model.state === 'error' || !check ? (
          <p className="fw-pord-hint" role="alert">
            {t('priceCheck.failed')}{' '}
            <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
              {t('state.retry')}
            </Button>
          </p>
        ) : (
          <PriceCheckBody check={check} />
        )}
        {model.notice ? (
          <p className="fw-pord-hint" role="status">
            {t(model.notice)}
          </p>
        ) : null}
        {model.access === 'read' && model.held ? (
          <p className="fw-pord-hint">
            <Lock size={12} aria-hidden /> {model.held}
          </p>
        ) : null}
      </section>
    </Card>
  )
}

function PriceCheckBody({ check }: { check: PortalPriceCheck }) {
  const words = useOrderWords()
  const { t } = words
  const card = priceCardOf(check)
  const money = (minor: number) => words.money(minor, check.currency)
  const lines = check.lines.length
  return (
    <>
      <Banner tone={card.tone === 'danger' ? 'danger' : card.tone === 'success' ? 'success' : 'info'} title={t(card.key, card.count !== undefined ? { count: card.count } : undefined)}>
        {card.missing > 0 && card.key !== 'priceCheck.none' ? <p>{t('priceCheck.missing', { missing: card.missing, lines })}</p> : null}
        {check.total.priceOtherCurrency > 0 ? <p>{t('priceCheck.otherCurrency', { count: check.total.priceOtherCurrency })}</p> : null}
      </Banner>
      <dl className="fw-pord-pricecheck-total">
        <div>
          <dt>{t('totals.net')}</dt>
          <dd>{money(check.total.ourPrice)}</dd>
        </div>
        <div>
          <dt>{t('priceCheck.yourTotal')}</dt>
          <dd>{check.total.brandPrice !== null ? money(check.total.brandPrice) : '—'}</dd>
        </div>
        <div>
          <dt>{t('priceCheck.check')}</dt>
          <dd>
            <MatchTag match={check.total.priceMatch} />
          </dd>
        </div>
        <div>
          <dt>{t('priceCheck.difference')}</dt>
          <dd>{diffText(check.total.priceDiff, money) ?? '—'}</dd>
        </div>
      </dl>
      {check.total.row ? <p className="fw-pord-hint">{t('priceCheck.totalRow', { source: t(sourceKey(check.total.row.source)) })}</p> : null}
      <p className="fw-pord-hint">{t('priceCheck.diffHint')}</p>
    </>
  )
}

/** "Your prices…": per line our unit price beside the customer's own (typed), one note, Save — the Buyer and the Admin, an open order. */
export function PriceCheckDialog({ model, check, actions }: { model: PriceDialogModel; check: PortalPriceCheck; actions?: PriceCheckActions['dialog'] }) {
  const words = useOrderWords()
  const { t, locale } = words
  const unit = (value: string | null) => unitPriceText(value, check.currency, locale) ?? '—'
  return (
    <Modal
      open
      onClose={() => (model.busy ? undefined : actions?.onClose?.())}
      sheet
      size="lg"
      title={t('priceCheck.dialogTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} disabled={model.busy}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" heldReason={model.busy ? t('priceCheck.saving') : null} onClick={() => actions?.onSave?.()}>
            {t('priceCheck.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pord-pricedialog"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onSave?.()
        }}
      >
        {model.stale ? <Banner tone="warning" title={t('priceCheck.stale')} /> : null}
        {model.failed ? <Banner tone="danger" title={t(model.failed)} /> : null}
        <SummaryTable
          label={t('priceCheck.dialogTitle')}
          density="roomy"
          stackOnPhone
          columns={[t('lines.col.line'), t('lines.col.pieces'), t('lines.col.price'), t('priceCheck.yours')]}
          align={['left', 'right', 'right', 'right']}
          widths={['40%', undefined, undefined, '220px']}
          rows={check.lines.map((line) => {
            const problem = model.showProblems ? model.problems.lines[line.lineId] : undefined
            const factory = line.row && line.row.source !== 'PORTAL' ? line.row : null
            return {
              id: line.lineId,
              cells: [
                `${line.seq} · ${line.label}`,
                String(line.pieces),
                unit(line.ourUnitPrice),
                <span key="yours" className="fw-pord-ownprice">
                  <Input
                    value={model.draft.prices[line.lineId] ?? ''}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={t('priceCheck.unit', { seq: line.seq })}
                    aria-invalid={problem ? true : undefined}
                    prefix={check.currency === 'EUR' ? '€' : check.currency}
                    onChange={(event) => actions?.onPrice?.(line.lineId, event.target.value)}
                  />
                  {factory ? <span className="fw-pord-sub">{t(sourceKey(factory.source))}</span> : null}
                  {problem ? (
                    <span className="fw-pord-ownprice-problem" role="alert">
                      {t(problem)}
                    </span>
                  ) : null}
                </span>,
              ],
            }
          })}
        />
        <Field label={t('priceCheck.note')} hint={t('priceCheck.noteHint')} error={model.showProblems && model.problems.note ? t(model.problems.note) : undefined}>
          <Textarea value={model.draft.note} rows={3} maxLength={1000} onChange={(event) => actions?.onNote?.(event.target.value)} />
        </Field>
        <p className="fw-pord-hint">{t('priceCheck.diffHint')}</p>
      </form>
    </Modal>
  )
}
