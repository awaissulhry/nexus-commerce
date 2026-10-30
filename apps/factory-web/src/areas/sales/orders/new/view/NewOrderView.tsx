'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { FileX } from 'lucide-react'
import { Banner, Card, DateField, EmptyState, Field, KeyValue, RecordLayout, Timeline } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money, percent } from '../../../quotes/model'
import { issuePhrases, namesOf, piecesOf } from '../../daily-model'
import { dayInstant } from '../../model'
import { LinesEditor } from '../../record/view/LinesEditor'
import { confirmHeld, dateProblems, previewByKey, sentLines, type NewOrderActions, type NewOrderModel } from '../new-model'
import '../../orders.css'

/**
 * SCR-039 (draft) — a typed New order (design pop:orders.new → "Lines tab editable until 'Confirm order'"; SAL-202):
 * the band "New order · <customer>" with "Draft — not confirmed", the number it will get and Confirm order (held with its
 * reason: no line yet, a price not read, a problem the API names); the order's dates and an internal note; the lines
 * editor (styles, colours, sizes, prices; an empty price is the customer's list price); the summary rail priced by the
 * API as it is typed — net, VAT, gross, the deposit and the payment schedule the order will get, the problems in words.
 * Nothing is written before Confirm order; this tab keeps the lines if it is reloaded.
 */
export function NewOrderView({ model, actions }: { model: NewOrderModel; actions?: NewOrderActions }) {
  return (
    <WithMessages namespaces={['orders', 'sales', 'lists']}>
      <NewOrder model={model} actions={actions} />
    </WithMessages>
  )
}

function NewOrder({ model, actions }: { model: NewOrderModel; actions?: NewOrderActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const listHref = `${model.prefix}/sales/orders`
  const party = model.party.status === 'ready' ? model.party.value : null
  const held = confirmHeld({ can: model.can, draft: model.draft, preview: model.preview, today: model.today, busy: model.busy })
  const heldText = held ? t(held.key, held.params) : null
  const dates = dateProblems(model.draft, model.today)
  const { nets, prices } = previewByKey(model.draft, model.preview.value)
  const pieces = model.draft.lines.reduce((sum, line) => sum + piecesOf(line), 0)

  // ⌘↵ confirms (not inside a dialog); leaving with lines typed asks first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
      if ((event.target as HTMLElement | null)?.closest('[role="dialog"]')) return
      event.preventDefault()
      if (!heldText) actions?.onConfirm?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (pieces === 0 || model.busy) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [pieces, model.busy])

  if (!model.header || model.party.status !== 'ready') {
    const state = !model.header ? 'missing' : model.party.status
    return (
      <div className="fw-so">
        <div className="fw-so-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('record.back')}</Link>} title={state === 'loading' ? <Skeleton width={260} height={22} /> : t('newOrder.pageTitle')} />
        </div>
        <Card padded aria-busy={state === 'loading' || undefined}>
          {state === 'loading' ? (
            <p className="fw-so-hint" role="status">
              <Spinner size={14} /> {t('newOrder.reading')}
            </p>
          ) : (
            <EmptyState
              icon={<FileX size={24} aria-hidden />}
              title={t(`newOrder.state.${state === 'error' ? 'error' : 'missing'}.title`)}
              description={model.party.status === 'error' ? t(model.party.problem) : t('newOrder.state.missing.body')}
              action={
                model.party.status === 'error' ? (
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={`${listHref}?new=1`}>{t('newOrder.startAgain')}</Link>
                  </Button>
                )
              }
            />
          )}
        </Card>
      </div>
    )
  }

  const preview = model.preview.value
  const priced = preview?.order ?? null
  const sent = sentLines(model.draft)
  const label = (index: number) => {
    const line = sent[index]
    if (!line) return null
    const names = namesOf(line, null, model.styles[line.styleId])
    return `${names.style} · ${names.colour}`
  }
  const problems = preview && !preview.ok ? issuePhrases(preview.problems, label) : []
  const currency = priced?.currency ?? 'EUR'
  const contact = party?.contacts.find((entry) => entry.id === model.header?.contactId) ?? null

  return (
    <div className="fw-so">
      <div className="fw-so-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={listHref}>{t('record.back')}</Link>}
          title={
            <span className="fw-so-title">
              {t('newOrder.pageTitle')} <span className="fw-so-title-sub">· {party?.legalName ?? '—'}</span>
            </span>
          }
          actions={
            <span className="fw-so-actions">
              <Button size="sm" onClick={() => actions?.onDiscard?.()} heldReason={model.busy ? t('held.busy') : null}>
                {t('newOrder.discard')}
              </Button>
              <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onConfirm?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
                {model.busy ? t('common.working') : t('newOrder.confirm')}
              </Button>
            </span>
          }
        />
        <div className="fw-so-meta-row">
          <span className="fw-so-meta">
            <Pill tone="neutral">{t('newOrder.draft')}</Pill>
            <span className="fw-so-hint" role="status">
              {model.number === undefined ? t('newOrder.numberLoading') : model.number === null ? t('newOrder.numberUnknown') : t('newOrder.number', { number: model.number })}
            </span>
            {model.header.customerRef && <Tag tone="neutral">{t('record.customerRef', { ref: model.header.customerRef })}</Tag>}
            {contact && <Tag tone="neutral">{t('newOrder.contactIs', { name: contact.name })}</Tag>}
          </span>
        </div>
      </div>

      {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
      <Banner tone="info" title={t('newOrder.nothingSaved')} />

      <RecordLayout
        asideLabel={t('summary.label')}
        main={
          <div className="fw-so-stack">
            <Card padded>
              <h2 className="fw-so-h2">{t('newOrder.details')}</h2>
              <div className="fw-so-two">
                <Field label={t('newOrder.requested')} hint={t('newOrder.requestedHint')} error={dates.requestedDate ? t(dates.requestedDate) : undefined}>
                  <DateField value={model.draft.requestedDate} onChange={(value) => actions?.onField?.('requestedDate', value)} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('newOrder.requested')} />
                </Field>
                <Field label={t('newOrder.promise')} hint={t('newOrder.promiseHint')} error={dates.promiseDate ? t(dates.promiseDate) : undefined}>
                  <DateField value={model.draft.promiseDate} onChange={(value) => actions?.onField?.('promiseDate', value)} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('newOrder.promise')} />
                </Field>
              </div>
              <Field label={t('newOrder.note')} hint={t('newOrder.noteHint')}>
                <Textarea value={model.draft.internalNote} onChange={(event) => actions?.onField?.('internalNote', event.target.value)} rows={2} maxLength={2000} />
              </Field>
            </Card>
            <LinesEditor
              model={{ mode: 'new', lines: model.draft.lines, order: null, styles: model.styles, composer: model.composer, price: model.can.price, currency, priceBasis: priced?.priceBasis ?? 'NET', minimums: {}, nets: model.can.price ? nets : undefined, listPrices: prices, busy: model.busy }}
              actions={{ onCells: actions?.onCells, onPrice: actions?.onPrice, onComposerQuery: actions?.onComposerQuery, onComposerPick: actions?.onComposerPick, onComposerToggle: actions?.onComposerToggle, onComposerAdd: actions?.onComposerAdd }}
            />
          </div>
        }
        aside={
          <div className="fw-so-rail">
            <Card padded>
              <h2 className="fw-so-h2">{t('summary.title')}</h2>
              <div aria-live="polite">
                {model.preview.phase === 'reading' && (
                  <p className="fw-so-hint" role="status">
                    <Spinner size={12} /> {t('newOrder.pricing')}
                  </p>
                )}
                {model.preview.phase === 'failed' && (
                  <Banner
                    tone="danger"
                    title={t(model.preview.problem ?? 'problem.read.internal')}
                    action={
                      <Button size="sm" onClick={() => actions?.onRetry?.()}>
                        {t('common.retry')}
                      </Button>
                    }
                  />
                )}
                <KeyValue
                  dense
                  labelCase="sentence"
                  items={[
                    { label: t('summary.lines'), value: t('summary.linesValue', { lines: sent.length, units: pieces }) },
                    ...(model.can.price
                      ? [
                          { label: t('summary.net'), value: money(priced?.netAmount, currency, locale) },
                          { label: t('summary.vat'), value: money(priced?.vatAmount, currency, locale) },
                          { label: t(priced?.priceBasis === 'GROSS' ? 'summary.grossConsumer' : 'summary.gross'), value: <strong>{money(priced?.grossAmount, currency, locale)}</strong> },
                          {
                            label: t('summary.deposit'),
                            value: !priced ? '—' : priced.depositPct ? t('newOrder.depositValue', { pct: percent(priced.depositPct, locale), amount: money(priced.depositAmount, currency, locale) }) : t('summary.depositNotNeeded'),
                          },
                        ]
                      : [{ label: t('summary.money'), value: t('summary.noPrice') }]),
                    { label: t('newOrder.terms'), value: priced?.paymentTerms ?? party?.paymentTerms ?? t('newOrder.termsNone') },
                    ...(model.can.cost ? [{ label: t('summary.cost'), value: priced?.costAmount === null || priced?.costAmount === undefined ? t('summary.costIncomplete') : money(priced.costAmount, currency, locale) }] : []),
                  ]}
                />
              </div>
            </Card>
            <Card padded>
              <h2 className="fw-so-h2">{t('schedule.title')}</h2>
              {!priced || priced.schedule.length === 0 ? (
                <p className="fw-so-hint">{priced ? t('schedule.empty') : t('newOrder.scheduleLater')}</p>
              ) : (
                <Timeline
                  label={t('schedule.label')}
                  steps={priced.schedule.map((step) => ({
                    key: String(step.seq),
                    tone: 'info',
                    label: (
                      <span className="fw-so-inline">
                        <span>{step.sharePct ? t('schedule.stepShare', { kind: t(`schedule.kind.${step.kind}`), share: percent(step.sharePct, locale) }) : t(`schedule.kind.${step.kind}`)}</span>
                        {model.can.price && <strong>{money(step.amount, currency, locale)}</strong>}
                      </span>
                    ),
                    detail: step.dueDate ? t('schedule.due', { date: formatDate(dayInstant(step.dueDate), { locale }) }) : t(`schedule.when.${step.kind}`),
                  }))}
                />
              )}
            </Card>
            {problems.length > 0 && (
              <Card padded>
                <h2 className="fw-so-h2">{t('newOrder.problems', { count: problems.length })}</h2>
                <ul className="fw-so-list">
                  {problems.map((entry, index) => (
                    <li key={`${entry.key}-${index}`}>{t(entry.key, entry.params)}</li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        }
      />
    </div>
  )
}
