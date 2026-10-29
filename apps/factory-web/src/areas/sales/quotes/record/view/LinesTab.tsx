'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, ShieldAlert, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, Modal, RecordLayout, SummaryTable } from '@nexus/ui/components'
import { SizeGridEditor, SizeGridView, type SizeGridIssue } from '@nexus/ui/grid/size-grid/index'
import { Button, Checkbox, InfoTip, Input, Pill, RadioCard, Spinner, Tag } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { QuoteDetail, QuoteLine, StyleDetail } from '../../api'
import { certificateIssues, gridShapeOf, gridValueOf, isEditable, marginTone, money, percent, styleBlocks, styleTags, unitPrice, unitsOf, type NextStepView, type StyleBlock } from '../../model'
import type { QuoteRecordActions, QuoteRecordViewModel } from '../record-model'
import { sizeGridWords } from './grid-copy'

/**
 * The Lines tab (design `quote.lines.*`): "Add a style" (type a style, pick its colours, Add: its grid opens ready for
 * numbers; `n` focuses the box), one block per style (colourways × sizes in one keyboard grid, autosaved; each colour
 * line's price, its net and — with the grains — its cost and margin %), and the summary rail (totals, VAT, deposit,
 * margin against the floor, approval, the next step). Read-only from the moment the version leaves Draft.
 */
export function LinesTab({ quote, model, actions, step }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions; step: NextStepView }) {
  const t = useT('sales')
  const editable = isEditable(quote, model.can)
  const blocks = useMemo(() => {
    const own = styleBlocks(quote.lines)
    for (const styleId of Object.keys(model.pendingColourways)) {
      if (own.some((block) => block.styleId === styleId)) continue
      const style = model.styles[styleId]
      if (style) own.push({ styleId, code: style.code, name: style.name, revision: null, lines: [] })
    }
    return own
  }, [quote.lines, model.pendingColourways, model.styles])

  return (
    <RecordLayout
      asideLabel={t('summary.label')}
      main={
        <div className="fw-q-stack">
          {editable && <Composer model={model} actions={actions} />}
          {blocks.length === 0 ? (
            <Card padded>
              <EmptyState title={t('lines.empty.title')} description={t(editable ? 'lines.empty.body' : 'lines.empty.bodyReadOnly')} />
            </Card>
          ) : (
            blocks.map((block) => <StyleBlockCard key={block.styleId} block={block} quote={quote} model={model} actions={actions} editable={editable} />)
          )}
          {editable && (
            <p className="fw-q-hint fw-q-tablefoot">
              {t('lines.autosave')} <InfoTip tip={t('lines.keys')} size={14} />
            </p>
          )}
        </div>
      }
      aside={<SummaryRail quote={quote} model={model} actions={actions} step={step} />}
    />
  )
}

function Composer({ model, actions }: { model: QuoteRecordViewModel; actions?: QuoteRecordActions }) {
  const t = useT('sales')
  const { composer } = model
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(composer.query)
  const typed = useRef(false)
  // A style was added (the container cleared the composer): the box empties for the next one.
  const cleared = composer.query === '' && composer.results === null && !composer.chosen
  useEffect(() => {
    if (cleared) setQuery('')
  }, [cleared])
  const search = useRef(actions?.onComposerQuery)
  search.current = actions?.onComposerQuery
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  // n: the Style box, from anywhere on the tab (not while typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      event.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const chosen = composer.chosen
  const held = !chosen ? t('composer.held.style') : composer.picked.length === 0 ? t('composer.held.colour') : model.busy ? t('held.busy') : null

  return (
    <Card padded className="fw-q-composer">
      <h2 className="fw-q-h2">{t('composer.title')}</h2>
      <Field label={t('composer.style')} hint={t('composer.styleHint')}>
        <Input
          ref={input}
          value={query}
          type="search"
          leadingIcon={<Search size={14} aria-hidden />}
          placeholder={t('composer.placeholder')}
          autoComplete="off"
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
          aria-keyshortcuts="n"
        />
      </Field>
      {composer.problem ? (
        <Banner tone="danger" title={t(composer.problem)} />
      ) : composer.results === null && query.trim() !== '' && !chosen ? (
        <p className="fw-q-hint" role="status">
          <Spinner size={14} /> {t('composer.searching')}
        </p>
      ) : composer.results && !chosen ? (
        <fieldset className="fw-q-choices">
          <legend className="fw-q-legend" aria-live="polite">
            {composer.results.length === 0 ? t('composer.none') : t('composer.found', { count: composer.results.length })}
          </legend>
          {composer.results.map((style) => (
            <RadioCard
              key={style.id}
              variant="row"
              name="fw-q-style"
              value={style.id}
              checked={false}
              onChange={() => actions?.onComposerPick?.(style.id)}
              title={`${style.code} · ${style.name}`}
              description={
                <span className="fw-q-tags">
                  {style.season && <Tag>{style.season}</Tag>}
                  {styleTags(style).map((tag) => (
                    <Tag key={tag} tone={tag === 'style.released' ? 'success' : tag === 'style.estimate' ? 'warning' : 'neutral'}>
                      {t(tag)}
                    </Tag>
                  ))}
                  {style.ppeClass && <Tag tone="info">{t('style.ppeClass', { value: style.ppeClass })}</Tag>}
                  <span className="fw-q-hint">{style.sizes.join(' · ')}</span>
                </span>
              }
            />
          ))}
        </fieldset>
      ) : null}
      {chosen && (
        <div className="fw-q-chosen">
          <div className="fw-q-chosen-head">
            <strong>
              {chosen.code} · {chosen.name}
            </strong>
            <Button size="sm" variant="quiet" onClick={() => actions?.onComposerClear?.()}>
              {t('composer.change')}
            </Button>
          </div>
          <fieldset className="fw-q-colours">
            <legend className="fw-q-legend">{t('composer.colours')}</legend>
            {chosen.colourways
              .filter((colourway) => colourway.status === 'ACTIVE')
              .map((colourway) => (
                <Checkbox
                  key={colourway.id}
                  className="fw-q-colour"
                  checked={composer.picked.includes(colourway.id)}
                  onChange={() => actions?.onComposerToggle?.(colourway.id)}
                  label={
                    <span className="fw-q-inline">
                      {colourway.colour?.hex && <span className="fw-q-swatch" style={{ background: colourway.colour.hex }} aria-hidden />}
                      {colourway.code} · {colourway.name}
                    </span>
                  }
                />
              ))}
          </fieldset>
          {chosen.revisionState !== 'RELEASED' && <p className="fw-q-hint">{t(chosen.revisionState === 'DRAFT' ? 'composer.estimate' : 'composer.noCost')}</p>}
          <div>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onComposerAdd?.()}>
              <Plus size={14} aria-hidden /> {t('composer.add', { count: composer.picked.length })}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function StyleBlockCard({ block, quote, model, actions, editable }: { block: StyleBlock; quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions; editable: boolean }) {
  const t = useT('sales')
  const locale = useLocale()
  const style: StyleDetail | null = model.styles[block.styleId] ?? null
  const pending = model.pendingColourways[block.styleId] ?? []
  const shape = gridShapeOf(block.lines, style, pending)
  const value = model.drafts[block.styleId] ?? gridValueOf(block.lines)
  const copy = useMemo(() => sizeGridWords(t), [t])
  const [confirmRemove, setConfirmRemove] = useState(false)
  const refused = certificateIssues(block.lines)
  const issues: SizeGridIssue[] = refused.map((item) => ({ colour: item.colour, size: item.size, tone: 'warning', message: t('lines.certificate', { size: item.size }) }))
  const currency = quote.current.currency
  const missingColourways = style ? style.colourways.filter((colourway) => colourway.status === 'ACTIVE' && !shape.colours.some((colour) => colour.key === colourway.id)) : []
  const revision = block.revision ?? block.lines.find((line) => line.styleRevision)?.styleRevision ?? null

  const priceRows = shape.colours.map((colour) => {
    const line: QuoteLine | undefined = block.lines.find((entry) => entry.colourwayId === colour.key)
    const key = `${block.styleId}:${colour.key}`
    const typedPrice = model.prices[key]
    const tone = line ? marginTone(line.marginPct, quote.current.marginFloorPct) : null
    return {
      id: colour.key,
      cells: [
        <span key="c" className="fw-q-cell">
          {colour.label}
        </span>,
        line ? String(line.quantity) : '0',
        model.grains.price ? (
          editable ? (
            <Input
              key={`p-${line?.unitPrice ?? typedPrice ?? ''}`}
              size="sm"
              fieldClassName="fw-q-price"
              inputMode="decimal"
              aria-label={t('lines.priceOf', { colour: colour.label })}
              defaultValue={typedPrice ?? line?.unitPrice ?? ''}
              placeholder={t('lines.pricePlaceholder')}
              onBlur={(event) => {
                const next = event.target.value
                if (next !== (typedPrice ?? line?.unitPrice ?? '')) actions?.onPrice?.(block.styleId, colour.key, next)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
              }}
            />
          ) : (
            unitPrice(line?.unitPrice, currency, locale)
          )
        ) : (
          '—'
        ),
        model.grains.price ? money(line?.netAmount, currency, locale) : '—',
        ...(model.grains.cost ? [line ? (line.costComplete ? unitPrice(line.unitCost, currency, locale) : t('lines.costMissing')) : '—'] : []),
        ...(model.grains.margin
          ? [
              line && line.marginPct !== undefined ? (
                <span key="m" className="fw-q-inline">
                  {percent(line.marginPct, locale)}
                  {tone === 'warning' || tone === 'danger' ? <Tag tone={tone}>{t('lines.belowFloor')}</Tag> : null}
                </span>
              ) : (
                '—'
              ),
            ]
          : []),
      ],
    }
  })
  const columns = [t('lines.col.colour'), t('lines.col.pieces'), t(quote.current.priceBasis === 'GROSS' ? 'lines.col.unitGross' : 'lines.col.unitNet'), t('lines.col.net'), ...(model.grains.cost ? [t('lines.col.unitCost')] : []), ...(model.grains.margin ? [t('lines.col.margin')] : [])]

  return (
    <Card padded className="fw-q-block">
      <div className="fw-q-block-head">
        <div className="fw-q-block-title">
          <h3 className="fw-q-h3">
            {block.code} · {block.name}
          </h3>
          <span className="fw-q-tags">
            {revision ? (
              <Tag tone={revision.status === 'RELEASED' ? 'success' : 'warning'}>{t(revision.status === 'RELEASED' ? 'lines.revReleased' : 'lines.revEstimate', { revision: revision.revision })}</Tag>
            ) : block.lines.length > 0 ? (
              <Tag tone="danger">{t('lines.noCostSheet')}</Tag>
            ) : null}
            {refused.length > 0 && (
              <Tag tone="warning">
                <ShieldAlert size={11} aria-hidden /> {t('lines.certificateCount', { count: refused.length })}
              </Tag>
            )}
            {style === null && block.lines.length > 0 && <Tag>{t('lines.styleUnread')}</Tag>}
          </span>
        </div>
        {editable && (
          <Menu
            label={t('lines.blockMenu')}
            align="right"
            items={[
              ...missingColourways.map((colourway) => ({ id: `add-${colourway.id}`, label: t('lines.addColour', { colour: `${colourway.code} · ${colourway.name}` }), icon: <Plus size={14} aria-hidden />, onSelect: () => actions?.onAddColourway?.(block.styleId, colourway.id) })),
              { id: 'remove', label: t('lines.removeStyle'), tone: 'danger' as const, icon: <Trash2 size={14} aria-hidden />, onSelect: () => setConfirmRemove(true) },
            ]}
          />
        )}
      </div>
      <div className="fw-q-gridbox">
      {editable ? (
        <SizeGridEditor colours={shape.colours} sizes={shape.sizes} value={value} onChange={(next) => actions?.onCells?.(block.styleId, next)} issues={issues} caption={t('grid.captionOf', { style: block.code })} locale={INTL_LOCALE[locale]} copy={copy} />
      ) : (
        <SizeGridView colours={shape.colours} sizes={shape.sizes} value={value} caption={t('grid.captionOf', { style: block.code })} locale={INTL_LOCALE[locale]} copy={copy} />
      )}
      </div>
      <SummaryTable label={t('lines.pricesOf', { style: block.code })} columns={columns} rows={priceRows} density="roomy" stackOnPhone align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))} />
      {confirmRemove && (
        <Modal
          open
          onClose={() => setConfirmRemove(false)}
          title={t('lines.removeTitle', { style: block.code })}
          size="sm"
          footer={
            <>
              <Button onClick={() => setConfirmRemove(false)}>{t('common.keep')}</Button>
              <Button
                variant="danger"
                heldReason={model.busy ? t('held.busy') : null}
                onClick={() => {
                  setConfirmRemove(false)
                  actions?.onRemoveBlock?.(block.styleId)
                }}
              >
                {t('lines.removeGo', { count: block.lines.length })}
              </Button>
            </>
          }
        >
          <p className="fw-q-hint">{t('lines.removeBody', { count: block.lines.length })}</p>
        </Modal>
      )}
    </Card>
  )
}

/** The summary rail (`quote.lines.summary`): the deal at a glance while typing, one polite live region for the totals. */
export function SummaryRail({ quote, model, actions, step }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions; step: NextStepView }) {
  const t = useT('sales')
  const locale = useLocale()
  const current = quote.current
  const currency = current.currency
  const tone = marginTone(current.marginPct, current.marginFloorPct)
  const broken = quote.approval.rules.filter((rule) => rule.broken)
  const items = [
    { label: t('summary.lines'), value: t('summary.linesValue', { lines: quote.lines.length, units: unitsOf(quote.lines) }) },
    ...(model.grains.price
      ? [
          { label: t('summary.net'), value: money(current.netAmount, currency, locale) },
          ...(current.vat ?? []).map((entry, index) => ({ label: entry.nature ? t('summary.vatNature', { nature: entry.nature }) : t('summary.vatRate', { rate: percent(entry.rate, locale) }), value: money(entry.vat, currency, locale), key: index })),
          { label: t(current.priceBasis === 'GROSS' ? 'summary.grossConsumer' : 'summary.gross'), value: <strong>{money(current.grossAmount, currency, locale)}</strong> },
          {
            label: t('summary.deposit'),
            value: current.depositPct && current.depositAmount ? t('summary.depositValue', { pct: percent(current.depositPct, locale), kind: t(`depositKind.${current.depositKind ?? 'ACCONTO'}`), amount: money(current.depositAmount, currency, locale) }) : t('summary.noDeposit'),
          },
        ]
      : [{ label: t('summary.money'), value: t('summary.noPrice') }]),
    ...(model.grains.cost ? [{ label: t('summary.cost'), value: current.costComplete ? money(current.costAmount, currency, locale) : t('summary.costIncomplete') }] : []),
    ...(model.grains.cost && model.grains.margin && current.marginAmount !== undefined ? [{ label: t('summary.marginAmount'), value: money(current.marginAmount, currency, locale) }] : []),
  ]
  const shortcut = step.step === 'send' ? 'action.send' : step.step === 'askApproval' ? 'action.ask' : null
  return (
    <div className="fw-q-rail">
      <Card padded>
        <h2 className="fw-q-h2">{t('summary.title')}</h2>
        <div aria-live="polite">
          <KeyValue dense labelCase="sentence" items={items.map(({ label, value }) => ({ label, value }))} />
        </div>
        {model.grains.margin && (
          <div className={`fw-q-meter tone-${tone ?? 'neutral'}`}>
            <span className="fw-q-meter-label">{t('summary.margin')}</span>
            <span className="fw-q-meter-value">
              {current.marginPct === null || current.marginPct === undefined
                ? t('summary.marginUnknown')
                : tone === 'success'
                  ? t('summary.marginOver', { pct: percent(current.marginPct, locale), floor: percent(current.marginFloorPct, locale) })
                  : t('summary.marginUnder', { pct: percent(current.marginPct, locale), floor: percent(current.marginFloorPct, locale) })}
            </span>
          </div>
        )}
        <p className="fw-q-rail-approval">
          {quote.approval.needed ? t('summary.needsApproval', { reasons: broken.map((rule) => t(`reason.${rule.reason}`)).join(' · ') }) : t('summary.noApproval')}
        </p>
        {current.validUntil && <p className="fw-q-hint">{t('summary.validUntil', { date: new Intl.DateTimeFormat(INTL_LOCALE[locale], { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${current.validUntil}T00:00:00Z`)) })}</p>}
        {shortcut && (
          <Button
            size="sm"
            variant="primary"
            heldReason={step.held ? t(step.held.key, step.held.params) : null}
            onClick={() => (step.step === 'send' ? actions?.onOpenSend?.() : actions?.onDialog?.('ask'))}
          >
            {t(shortcut)}
          </Button>
        )}
        {quote.issues.filter((issue) => issue.severity !== 'INFO').length > 0 && (
          <ul className="fw-q-issues" aria-label={t('summary.issues')}>
            {quote.issues
              .filter((issue) => issue.severity !== 'INFO')
              .map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <Pill tone={issue.severity === 'WARNING' ? 'warning' : 'danger'}>{t(`severity.${issue.severity}`)}</Pill> {t(`issue.${issue.code}`, { size: issue.size ?? '' })}
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
