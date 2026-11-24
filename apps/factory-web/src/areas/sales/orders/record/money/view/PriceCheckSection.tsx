'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileText, Hand, Inbox, RefreshCw } from 'lucide-react'
import { Banner, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate, formatNumber } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money, unitPrice } from '../../../../quotes/model'
import type { Order } from '../../../api'
import type { PriceCheck } from '../../../price-check/api'
import { sourceWords } from '../../../price-check/model'
import { PriceCheckDialog } from '../../../price-check/PriceCheckDialog'
import type { Phrase } from '../../../model'
import { seqList } from '../../price-check-card'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, PartReading, Section } from '../../view/production/Kit' // F-OM-101 (L6): the Production kit, in place
import { priceCheckOf, type PriceCheckView, type PriceLineRow, type PriceTag } from '../price'
import { Fold } from './parts' // F-CM-k1: the shared fold
import { lineOf, useSay, type Say } from './say'

/**
 * F-OM-301 (order MONEY tab, 10-design §7) — section 4, Price check (#price-check), in the kit (moved from view/PriceCheckSection.tsx,
 * F-CP-142): ONE head line (= Prices equal, folded · ≠ Not equal, the differing lines first · Accepted by hand · No customer price
 * yet), at most three doors (Customer's price… · Change our price › on the first differing line · ⋯ Accept the difference… / Undo the
 * acceptance… / History ›), the lines (Line · Pieces · Our amount with where our price came from · Customer's amount · Check ·
 * Difference: blocks under 600 px of the list, six columns from 600), where the customer's price came from, the take-over row of a
 * request that named its prices, and the ONE customer's-price window (so/price-check). HIDDEN without the price grain: nothing drawn
 * and nothing read (the tab's head says the money wall once). Draws its model; the container (use-price-check-card.ts) reads.
 */
export function PriceCheckSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  if (!model.can.price) return null
  const read = model.priceCheck?.read
  if (!read || read.state === 'held') return null
  const title = t('moneyTab.price.title')
  const info = (
    <>
      <p>{t('moneyTab.price.info')}</p>
      <p>{t('moneyTab.price.keys')}</p>
    </>
  )
  const dialog = model.priceCheckDialog ? <PriceCheckDialog model={model.priceCheckDialog} actions={actions?.priceCheckDialog ?? {}} /> : null
  if (read.state === 'loading') {
    return (
      <Section id="price-check" title={title} answer={t('priceCheck.reading')} info={info}>
        <PartReading rows={3} />
      </Section>
    )
  }
  if (read.state === 'failed') {
    return (
      <Section id="price-check" title={title} info={info}>
        <PartFailed part={t('moneyTab.price.part')} problem={read.problem} onRetry={() => actions?.priceCheck?.onRetry?.()} />
      </Section>
    )
  }
  return (
    <>
      <Filled order={order} model={model} actions={actions} check={read.check} stale={read.stale} taking={read.taking} problem={read.problem} title={title} info={info} />
      {dialog}
    </>
  )
}

function Filled({ order, model, actions, check, stale, taking, problem, title, info }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; check: PriceCheck; stale: boolean; taking: boolean; problem: Phrase | null; title: string; info: ReactNode }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = useSay(check.currency)
  const view = priceCheckOf({ check, order, can: model.can, prefix: model.prefix, canHistory: model.priceCheck?.canHistory ?? false, taking })
  // Equal prices are folded (Show the lines); any other state shows its lines, whatever was toggled before a re-read.
  const [opened, setOpened] = useState(false)
  const [all, setAll] = useState(false)
  const amount = (value: number | null) => (value === null ? '' : money(value, check.currency, locale))

  // ---- the head: ONE line, ≤ 3 doors, the rest in ⋯ ----
  const answer = (
    <span className="fw-pt-inline fw-om-pc-a">
      {view.tags.map((tag) => (
        <Tag key={tag.word.key} tone={tag.tone}>
          {say(tag.word)}
        </Tag>
      ))}
      <span>{lineOf(view.answer.map(say))}</span>
    </span>
  )
  const buttons = [
    view.folded ? (
      <Button key="show" size="sm" variant="quiet" aria-expanded={opened} onClick={() => setOpened((now) => !now)}>
        {opened ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />} {t(opened ? 'moneyTab.price.hide' : 'moneyTab.price.show')}
      </Button>
    ) : null,
    view.edit ? (
      <Button key="edit" size="sm" variant={view.edit.primary ? 'primary' : undefined} heldReason={view.edit.held ? say(view.edit.held) : null} onClick={() => actions?.priceCheck?.onEdit?.()}>
        {t('priceCheck.card.edit')}
      </Button>
    ) : null,
    // F-OL-04: Change our price › lands on Lines at the FIRST line that differs, its Unit price box focused (one edit path).
    view.change ? (
      <Button key="change" size="sm" variant="quiet" heldReason={view.change.held ? say(view.change.held) : null} onClick={() => actions?.linesTab?.onLand?.({ lineId: view.change?.lineId ?? null, box: 'price' })}>
        {t('priceCheck.card.changeOurs')}
      </Button>
    ) : null,
  ].filter((button) => button !== null)
  const items: MenuItemDef[] = []
  if (view.accept) items.push({ id: 'accept', label: t('moneyTab.price.accept.door'), disabled: !!view.accept.held, description: view.accept.held ? say(view.accept.held) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'priceAccept' }) })
  if (view.undoAccept) items.push({ id: 'undoAccept', label: t('moneyTab.price.unaccept.door'), disabled: !!view.undoAccept.held, description: view.undoAccept.held ? say(view.undoAccept.held) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'priceUnaccept' }) })
  if (view.history) items.push({ id: 'history', label: t('priceCheck.card.history'), href: view.history })
  const more = items.length > 0 ? <LineMenuButton label={t('moneyTab.price.more')} items={items} /> : undefined

  const rows = all ? view.rows : view.first
  const body = (!view.folded || opened) && view.state !== 'none'
  return (
    <Section id="price-check" title={title} answer={answer} buttons={buttons} more={more} info={info}>
      {/* ONE line of the section's own state: a refusal of the take-over, or "Here they are now" after one. */}
      {stale ? <Banner tone="warning" icon={<RefreshCw size={18} aria-hidden />} title={t('priceCheck.stale')} /> : problem ? <Banner tone="danger" title={t(problem.key, problem.params)} /> : null}
      {check.fromRequest && model.can.manage ? (
        <div className="fw-om-pc-take" role="group" aria-label={t('priceCheck.card.takeOverLabel')}>
          <span className="fw-pt-inline">
            <Inbox size={14} aria-hidden />
            {check.fromRequest.number ? t('priceCheck.card.takeOver', { number: check.fromRequest.number }) : t('priceCheck.card.takeOverNoNumber')}
            <span className="fw-pt-sub">{t('priceCheck.card.takeOverLines', { count: check.fromRequest.lines })}</span>
          </span>
          <Button size="sm" variant="primary" heldReason={view.edit?.held ? say(view.edit.held) : null} onClick={() => actions?.priceCheck?.onTakeOver?.(check.fromRequest!.requestId)}>
            {t('priceCheck.card.takeOverAction')}
          </Button>
        </div>
      ) : null}
      {view.accepted ? (
        <p className="fw-om-pc-acc">
          <Hand size={14} aria-hidden />
          <span>
            {say(view.accepted.words)}
            {view.accepted.reason ? `: ${t('priceCheck.card.note', { note: view.accepted.reason })}` : null}
          </span>
        </p>
      ) : null}
      {body ? (
        <>
          <div className="fw-om-pcl" role="table" aria-label={t('priceCheck.card.tableLabel', { number: check.number })}>
            <div className="fw-om-pcr is-hd" role="row">
              <div role="columnheader">{t('priceCheck.col.line')}</div>
              <div className="fw-om-pc-n" role="columnheader">
                {t('priceCheck.col.pieces')}
              </div>
              <div className="fw-om-pc-n" role="columnheader">
                {t('priceCheck.card.col.ourAmount')}
              </div>
              <div className="fw-om-pc-n" role="columnheader">
                {t('priceCheck.card.col.theirAmount')}
              </div>
              <div role="columnheader">{t('priceCheck.card.col.check')}</div>
              <div className="fw-om-pc-f" role="columnheader">
                {t('priceCheck.card.col.diff')}
              </div>
            </div>
            {rows.map((row) => (
              <LineRow key={row.id} row={row} currency={check.currency} say={say} />
            ))}
            {all || view.first.length === view.rows.length ? (
              <div className="fw-om-pcr is-tot" role="row">
                <div className="fw-om-pc-l" role="cell">
                  {t('priceCheck.card.total')}
                </div>
                <div className="fw-om-pc-n fw-om-pc-w" role="cell">
                  {formatNumber(view.total.pieces, locale)}
                </div>
                <div className="fw-om-pc-n fw-om-pc-w" role="cell">
                  {amount(view.total.ours)}
                </div>
                <div className="fw-om-pc-n fw-om-pc-w" role="cell">
                  {amount(view.total.theirs)}
                </div>
                <div className="fw-om-pc-o" role="cell">
                  <span>{t('moneyTab.price.ours', { amount: amount(view.total.ours) })}</span>
                  {view.total.theirs !== null ? <span>{t('moneyTab.price.theirs', { amount: amount(view.total.theirs) })}</span> : null}
                </div>
                <div className="fw-om-pc-c" role="cell">
                  <CheckTag tag={view.total.check} say={say} />
                  {view.total.check.word.key === 'moneyTab.price.check.NOT_EQUAL' && view.total.lines > 0 ? <span className="fw-pt-sub">{t('priceCheck.lines', { count: view.total.lines })}</span> : null}
                </div>
                <div className="fw-om-pc-f" role="cell">
                  <Diff diff={view.total.diff} currency={check.currency} />
                </div>
              </div>
            ) : null}
          </div>
          {view.first.length < view.rows.length ? (
            <Fold open={all} onToggle={() => setAll((now) => !now)} label={all ? t('moneyTab.price.onlyDiffering') : t('moneyTab.price.showAll', { count: view.rows.length })} />
          ) : null}
          <Sources view={view} check={check} />
        </>
      ) : null}
    </Section>
  )
}

/** One line: blocks under 600 px of the list (line + check on the first line, the amounts, the difference), six columns from 600. */
function LineRow({ row, currency, say }: { row: PriceLineRow; currency: string; say: Say }) {
  const t = useT('orders')
  const locale = useLocale()
  const ours = money(row.ours, currency, locale)
  const theirs = row.theirs === null ? null : money(row.theirs, currency, locale)
  const ourSub = [t('moneyTab.price.perPiece', { price: unitPrice(row.ourUnit, currency, locale) }), ...(row.ourSource ? [say(row.ourSource)] : [])].join(' · ')
  const theirSub = row.theirUnit ? t('moneyTab.price.perPiece', { price: unitPrice(row.theirUnit, currency, locale) }) : row.theirLineTotal ? t('priceCheck.lineTotal') : null
  return (
    <div className={`fw-om-pcr${row.differs ? ' is-diff' : ''}`} role="row">
      <div className="fw-om-pc-l" role="cell">
        <b>{`${row.seq} · ${row.label}`}</b>
      </div>
      <div className="fw-om-pc-n fw-om-pc-w" role="cell">
        {formatNumber(row.pieces, locale)}
      </div>
      <div className="fw-om-pc-n fw-om-pc-w" role="cell">
        {ours}
        <span className="fw-pt-sub">{ourSub}</span>
      </div>
      <div className="fw-om-pc-n fw-om-pc-w" role="cell">
        {theirs}
        {theirSub ? <span className="fw-pt-sub">{theirSub}</span> : null}
      </div>
      <div className="fw-om-pc-o" role="cell">
        <span>{t('moneyTab.price.pieces', { count: row.pieces })}</span>
        <span>{t('moneyTab.price.ours', { amount: ours })}</span>
        {theirs ? <span>{t('moneyTab.price.theirs', { amount: theirs })}</span> : null}
        <span className="fw-pt-sub">{ourSub}</span>
      </div>
      <div className="fw-om-pc-c" role="cell">
        {row.check ? <CheckTag tag={row.check} say={say} /> : <span className="fw-pt-sub">{t('priceCheck.card.notChecked')}</span>}
      </div>
      <div className="fw-om-pc-f" role="cell">
        <Diff diff={row.diff} currency={currency} />
      </div>
    </div>
  )
}

/** The check: a DS Tag whose words carry the mark (= / ≠), never colour alone; "— No customer price yet" in plain words. */
function CheckTag({ tag, say }: { tag: PriceTag; say: Say }) {
  if (tag.tone === 'neutral') return <span className="fw-pt-sub">{say(tag.word)}</span>
  return <Tag tone={tag.tone}>{say(tag.word)}</Tag>
}

/** The difference: "+€ 60.00 · we ask more", "−€ 10.00 · we ask less", "€ 0.00"; nothing while the customer's is not known. */
function Diff({ diff, currency }: { diff: number | null; currency: string }) {
  const t = useT('orders')
  const locale = useLocale()
  if (diff === null) return null
  if (diff === 0) return <span>{money(0, currency, locale)}</span>
  return (
    <span className="fw-om-pc-d">
      <span>{diff > 0 ? `+${money(diff, currency, locale)}` : `−${money(-diff, currency, locale)}`}</span>
      <span className="fw-pt-sub">{t(diff > 0 ? 'priceCheck.more' : 'priceCheck.less')}</span>
    </span>
  )
}

/** Where the customer's price came from: one line per source (its lines, its PO file, who typed it, when, the note), then the rule. */
function Sources({ view, check }: { view: PriceCheckView; check: PriceCheck }) {
  const t = useT('orders')
  const locale = useLocale()
  const total = check.total
  return (
    <div className="fw-om-pc-src">
      {view.sources.map((source) => (
        <p key={source.key} className="fw-om-pc-src-l">
          <FileText size={13} aria-hidden />
          <span>
            {lineOf(
              [
                t(sourceWords(source.source)),
                source.seqs.length > 0 ? t('priceCheck.card.linesOf', { count: source.seqs.length, list: seqList(source.seqs) }) : null,
                source.total ? t('priceCheck.orderTotal') : null,
                source.file ? source.file.name : null,
                source.by ? t('priceCheck.card.typedBy', { name: source.by, date: formatDate(source.at, { locale }) }) : formatDate(source.at, { locale }),
                source.note ? t('priceCheck.card.note', { note: source.note }) : null,
              ].filter((part): part is string => !!part),
            )}
          </span>
        </p>
      ))}
      <p className="fw-om-pc-src-l is-rule">{t('moneyTab.price.exact')}</p>
      {total.priceMissingLines > 0 && view.state !== 'partial' ? <p className="fw-om-pc-src-l">{t('priceCheck.card.missing', { missing: total.priceMissingLines, lines: check.lines.length })}</p> : null}
      {total.priceOtherCurrency > 0 ? <p className="fw-om-pc-src-l">{t('priceCheck.otherCurrency', { count: total.priceOtherCurrency })}</p> : null}
    </div>
  )
}
