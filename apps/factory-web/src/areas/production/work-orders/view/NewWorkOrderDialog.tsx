'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Banner, DateField, Field, Modal } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridIssue } from '@nexus/ui/grid'
import { Button, Checkbox, Input, RadioCard, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { sizeGridCopy } from '../../_shared/grid-copy'
import type { ProductionCan } from '../../_shared/model'
import { createHeld, linesOfStyle, newPieces, overOpen, stylesOf, type NewWorkOrderModel, type WorkOrdersListActions } from '../list-model'

/**
 * "New work order" (design wo-new; Today's New ▾ and `?new=1` open it): a confirmed sales order (search by number or
 * customer reference), its open lines of ONE style (a made-to-measure line comes later), the pieces per colourway and
 * size (everything still open by default; never more than is open), a due date (default: the earliest promise of the
 * lines), and the number it will get. "Create draft" (⌘↵) opens the new draft.
 */
export function NewWorkOrderDialog({ model, can, actions }: { model: NewWorkOrderModel; can: ProductionCan; actions?: WorkOrdersListActions }) {
  const t = useT('production')
  const locale = useLocale()
  const act = actions?.newOrder
  const [query, setQuery] = useState(model.query)
  const typed = useRef(false)
  const latest = useRef(act)
  latest.current = act
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onQuery?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])

  const styles = stylesOf(model.lines)
  const lines = linesOfStyle(model.lines, model.styleId)
  const pickedLines = lines.filter((line) => model.picked.includes(line.id))
  const sizes = useMemo(() => {
    const order: string[] = []
    for (const line of pickedLines) for (const size of line.sizes) if (!order.includes(size.size)) order.push(size.size)
    return order.map((size) => ({ key: size, label: size }))
  }, [pickedLines])
  const over = overOpen(lines, model.picked, model.grid)
  const issues: SizeGridIssue[] = over.map((cell) => ({ colour: cell.lineId, size: cell.size, message: t('new.over', { open: cell.open }), tone: 'error' }))
  const held = createHeld(model, can)
  const heldText = held ? t(held.key, held.params) : null
  const pieces = newPieces(model.picked, model.grid)
  const copy = useMemo(() => sizeGridCopy(t), [t])

  return (
    <Modal
      open
      onClose={() => act && actions?.onNew?.(false)}
      title={t('new.title')}
      subtitle={model.lines?.numberPreview ? t('new.number', { number: model.lines.numberPreview }) : undefined}
      size="lg"
      footer={
        <>
          <span className="fw-pr-hint">{model.picked.length > 0 ? t('new.pieces', { count: pieces }) : ''}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onNew?.(false)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => act?.onCreate?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('new.create')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pr-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) act?.onCreate?.()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            if (!held) act?.onCreate?.()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        {!can.orders && <Banner tone="info" title={t('new.noOrders')} />}

        <Field label={t('new.order')} hint={t('new.orderHint')}>
          <Input
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            value={query}
            placeholder={t('new.orderSearch')}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        </Field>
        {model.ordersProblem && <p className="fw-pr-hint">{t(model.ordersProblem)}</p>}
        {model.orders && model.orders.length === 0 && <p className="fw-pr-hint">{t('new.noOrderFound')}</p>}
        {model.orders && model.orders.length > 0 && (
          <fieldset className="fw-pr-list" aria-label={t('new.order')}>
            {model.orders.map((order) => (
              <RadioCard
                key={order.id}
                variant="row"
                name="fw-pr-new-order"
                checked={model.chosen?.id === order.id}
                selected={model.chosen?.id === order.id}
                onChange={() => act?.onChoose?.(order)}
                title={`${order.number} · ${order.partyName}`}
                description={[order.customerRef ? t('new.ref', { ref: order.customerRef }) : null, t('new.units', { count: order.units })].filter(Boolean).join(' · ')}
              />
            ))}
          </fieldset>
        )}

        {model.chosen && !model.lines && !model.linesProblem && (
          <p className="fw-pr-hint" role="status">
            <Spinner size={12} /> {t('new.loadingLines')}
          </p>
        )}
        {model.linesProblem && <Banner tone="danger" title={t(model.linesProblem)} />}

        {model.lines && styles.length > 1 && (
          <fieldset className="fw-pr-list">
            <legend className="fw-pr-h3">{t('new.style')}</legend>
            {styles.map((style) => (
              <RadioCard
                key={style.id}
                variant="row"
                name="fw-pr-new-style"
                checked={model.styleId === style.id}
                selected={model.styleId === style.id}
                onChange={() => act?.onStyle?.(style.id)}
                title={`${style.code} · ${style.name}`}
                description={t('new.openPieces', { count: style.open })}
              />
            ))}
          </fieldset>
        )}

        {model.lines && styles.every((style) => style.open === 0) && <p className="fw-pr-hint">{t('new.nothingOpen')}</p>}

        {lines.length > 0 && (
          <fieldset className="fw-pr-list">
            <legend className="fw-pr-h3">{t('new.lines')}</legend>
            {lines.map((line) => {
              const open = line.sizes.reduce((sum, size) => sum + size.open, 0)
              const reason = line.madeToMeasure ? t('new.mtmLater') : open === 0 ? t('new.lineFull') : null
              return (
                <Checkbox
                  key={line.id}
                  checked={model.picked.includes(line.id)}
                  disabled={!!reason}
                  onChange={(event) => act?.onPick?.(line.id, event.target.checked)}
                  label={
                    <span className="fw-pr-check-body">
                      <span>{t('new.line', { seq: line.seq, colourway: line.colourwayCode, style: line.styleCode })}</span>
                      <span className="fw-pr-cell-sub">
                        {reason ?? line.sizes.filter((size) => size.open > 0).map((size) => t('new.sizeOpen', { size: size.size, open: size.open })).join(' · ')}
                      </span>
                    </span>
                  }
                />
              )
            })}
          </fieldset>
        )}

        {pickedLines.length > 0 && (
          <div className="fw-pr-gridbox">
            <h3 className="fw-pr-h3">{t('new.sizes')}</h3>
            <SizeGridEditor
              colours={pickedLines.map((line) => ({ key: line.id, label: line.colourwayCode, offered: line.sizes.filter((size) => size.open > 0).map((size) => size.size) }))}
              sizes={sizes}
              value={model.grid}
              onChange={(next) => act?.onGrid?.(next)}
              issues={issues}
              locale={locale === 'it' ? 'it-IT' : 'en-GB'}
              copy={copy}
              caption={t('new.sizes')}
            />
          </div>
        )}

        {model.chosen && (
          <Field label={t('new.due')} hint={t('new.dueHint')}>
            <DateField value={model.dueDate} onChange={(value) => act?.onDueDate?.(value)} clearable clearLabel={t('new.dueClear')} ariaLabel={t('new.due')} />
          </Field>
        )}
      </form>
    </Modal>
  )
}
