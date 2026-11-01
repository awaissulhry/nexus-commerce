'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { AlarmClock, CheckCheck, ChevronDown, ChevronUp, ExternalLink, FileCheck2 } from 'lucide-react'
import { Banner, KeyValue } from '@nexus/ui/components'
import { Button, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import type { PlanningException } from '../api'
import { ackHeld, fixesOf, impactOf, kindTone, neighboursOf, resolveHeld, sentenceOf, snoozeHeld, statusTone, statusWords, titleOf, whatOf, type Words } from '../model'
import type { ExceptionsActions, ExceptionsModel } from '../view-model'

/**
 * The exception's detail (design planning.exceptions pop:detail, "SO-1043 will be 6 days late"; a DetailModal opened by
 * Enter or `?open=<id>`): the exception in plain words, the facts behind it, who owns it and what was done, and the fixes
 * it points to — each a real link (⌘-click keeps the queue open while fixing). A acknowledges, S snoozes, R resolves
 * with a note; K / J the previous and next exception of the queue; Esc closes. The root-cause chain is W3.
 */
export function ExceptionDetail({ model, actions, order, words }: { model: ExceptionsModel; actions?: ExceptionsActions; order: readonly string[]; words: Words }) {
  const { t } = words
  const detail = model.detail!
  const row = detail.loaded.status === 'ready' ? detail.loaded.value : null
  // A snoozed or resolved exception leaves the queue's view while its detail stays open: K / J then go on from the
  // place it had (J = the row that took its place), never stop.
  const seen = useRef<{ id: string; at: number } | null>(null)
  const { prev, next } = neighboursOf(order, detail.id, seen.current)
  const at = order.indexOf(detail.id)
  if (at >= 0) seen.current = { id: detail.id, at }
  const busyHeld = model.busy.length > 0 ? t('held.busy') : null
  const ack = row ? (ackHeld(row, model.can) ?? null) : 'held.loading'
  const snooze = row ? (snoozeHeld(row, model.can) ?? null) : 'held.loading'
  const resolve = row ? (resolveHeld(row, model.can) ?? null) : 'held.loading'
  const held = { ack: ack ? t(ack) : busyHeld, snooze: snooze ? t(snooze) : busyHeld, resolve: resolve ? t(resolve) : busyHeld }

  const latest = useRef({ actions, prev, next, held, row })
  latest.current = { actions, prev, next, held, row }
  const quiet = model.dialog !== null
  useEffect(() => {
    if (quiet) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      const key = event.key.toLowerCase()
      const act = (run: () => void) => {
        event.preventDefault()
        run()
      }
      if (key === 'j' && now.next) act(() => now.actions?.onOpen?.(now.next))
      else if (key === 'k' && now.prev) act(() => now.actions?.onOpen?.(now.prev))
      else if (key === 'a' && now.row && !now.held.ack) act(() => now.actions?.onAcknowledge?.([now.row!.id]))
      else if (key === 's' && now.row && !now.held.snooze) act(() => now.actions?.onSnooze?.(now.row!.id))
      else if (key === 'r' && now.row && !now.held.resolve) act(() => now.actions?.onResolve?.(now.row!.id))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet])

  return (
    <DetailModal
      open
      onClose={() => actions?.onOpen?.(null)}
      title={row ? titleOf(row, words) : t('detail.titleLoading')}
      subtitle={row ? whatOf(row, words) : undefined}
      meta={
        row ? (
          <>
            <Tag tone={kindTone(row.kind)}>{t(`kind.${row.kind}`)}</Tag>
            <Pill tone={statusTone(row)}>{statusWords(row, words)}</Pill>
          </>
        ) : undefined
      }
      loading={detail.loaded.status === 'loading'}
      error={detail.loaded.status === 'error' ? t(detail.loaded.problem) : undefined}
      onRetry={() => actions?.onOpen?.(detail.id)}
      actions={
        <>
          <span className="fw-px-inline">
            <Button size="sm" variant="quiet" aria-label={t('detail.prev')} heldReason={prev ? null : t('detail.first')} onClick={() => prev && actions?.onOpen?.(prev)} aria-keyshortcuts="k">
              <ChevronUp size={16} aria-hidden /> <Kbd>K</Kbd>
            </Button>
            <Button size="sm" variant="quiet" aria-label={t('detail.next')} heldReason={next ? null : t('detail.last')} onClick={() => next && actions?.onOpen?.(next)} aria-keyshortcuts="j">
              <ChevronDown size={16} aria-hidden /> <Kbd>J</Kbd>
            </Button>
          </span>
          {row && (
            <>
              <Button size="sm" heldReason={held.snooze} onClick={() => actions?.onSnooze?.(row.id)} aria-keyshortcuts="s">
                <AlarmClock size={14} aria-hidden /> {t('detail.snooze')} <Kbd>S</Kbd>
              </Button>
              <Button size="sm" heldReason={held.resolve} onClick={() => actions?.onResolve?.(row.id)} aria-keyshortcuts="r">
                <FileCheck2 size={14} aria-hidden /> {t('detail.resolve')} <Kbd>R</Kbd>
              </Button>
              <Button size="sm" variant="primary" heldReason={held.ack} onClick={() => actions?.onAcknowledge?.([row.id])} aria-keyshortcuts="a">
                <CheckCheck size={14} aria-hidden /> {t('detail.acknowledge')} <Kbd>A</Kbd>
              </Button>
            </>
          )}
        </>
      }
    >
      {row && <DetailBody row={row} model={model} words={words} />}
    </DetailModal>
  )
}

function DetailBody({ row, model, words }: { row: PlanningException; model: ExceptionsModel; words: Words }) {
  const { t, locale } = words
  const place = { locale, timeZone: model.timeZone }
  const fixes = fixesOf(row, { prefix: model.prefix, siteId: model.siteId })
  const person = (value: { name: string } | null, when: string | null) => (value ? (when ? t('detail.byAt', { name: value.name, time: formatDateTime(when, place) }) : value.name) : '—')
  return (
    <div className="fw-px-detail">
      <div className="fw-px-section">
        {row.status === 'RESOLVED' && (
          <Banner tone="success" title={row.resolution === 'CLEARED' ? t('detail.cleared') : t('detail.resolvedBy', { name: row.resolvedBy?.name ?? '—' })}>
            {row.resolveNote ?? undefined}
          </Banner>
        )}
        {row.snoozed && <Banner tone="info" title={row.snoozedUntil ? t('detail.snoozedUntil', { time: formatDateTime(row.snoozedUntil, place) }) : t('detail.snoozedRun')} />}
        <section className="fw-px-section" aria-labelledby="fw-px-words">
          <h3 id="fw-px-words" className="fw-px-h3">
            {t('detail.words')}
          </h3>
          <p className="fw-px-text">{sentenceOf(row, words)}</p>
        </section>
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('detail.impact'), value: impactOf(row, words) },
            { label: t('detail.found'), value: formatDate(row.firstSeenAt, place), hint: row.occurrence > 1 ? t('row.again', { count: row.occurrence }) : t('detail.age', { count: row.ageDays }) },
            { label: t('detail.lastSeen'), value: formatDateTime(row.lastSeenAt, place) },
            { label: t('detail.owner'), value: row.owner ? (row.mine ? t('detail.ownerYou', { name: row.owner.name }) : row.owner.name) : t('owner.none') },
            { label: t('detail.acknowledged'), value: person(row.acknowledgedBy, row.acknowledgedAt) },
            { label: t('detail.record'), value: row.record?.label ?? '—' },
          ]}
        />
        <p className="fw-px-hint">{t('detail.chainLater')}</p>
      </div>
      <section className="fw-px-section" aria-labelledby="fw-px-fixes">
        <h3 id="fw-px-fixes" className="fw-px-h3">
          {t('detail.fixes')}
        </h3>
        {fixes.length === 0 ? (
          <p className="fw-px-hint">{t('detail.noFix')}</p>
        ) : (
          <ul className="fw-px-fixes">
            {fixes.map((fix) => (
              <li key={fix.id}>
                <Button size="sm" variant={fix === fixes[0] ? 'secondary' : 'quiet'} asChild>
                  <Link href={fix.href}>
                    <ExternalLink size={13} aria-hidden /> {t(fix.label, fix.params)}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="fw-px-hint">{t('detail.fixHint')}</p>
      </section>
    </div>
  )
}
