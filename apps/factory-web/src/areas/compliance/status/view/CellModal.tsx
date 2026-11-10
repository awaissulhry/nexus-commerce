'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { CheckList, type CheckItem } from '@nexus/ui/patterns/checklist/index'
import { Button, Tag } from '@nexus/ui/primitives'
import { DetailModal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { BoardRow, CellDetail, CellItem, LineState } from '../api'
import { cellWalk, fixHeld, fixHref, marketName, recordHref } from '../model'
import { CellMark } from './Panels'
import type { StatusActions, StatusModel } from './types'

/** The checklist's state per line (DS CheckList): Present ✓ · Missing ✕ · Expiring ! · Not needed – · checked by a person ?. */
const LINE_CHECK: Readonly<Record<LineState, CheckItem['state']>> = { OK: 'pass', MISSING: 'fail', EXPIRING: 'warning', NOT_NEEDED: 'skipped', MANUAL: 'unknown', OVERRIDDEN: 'warning' }

/** The PPE categories (factory-db PpeCategory) the subtitle says in words. */
const PPE_CATEGORIES: readonly string[] = ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III']

/** The words of a requirement in the page's language (the API's English when it holds none). */
const inLanguage = (words: Readonly<Record<string, string>>, locale: string, fallback: string): string => words[locale] ?? words.en ?? fallback

/**
 * pop:cs-cell — "Style × market requirements" (design compliance.status; PRD-271): the DS DetailModal "JK-100 × Germany" with
 * the requirement checklist of what must exist before making and shipping this style to this market — each line's state in an
 * icon AND a word (Present / Missing / Expiring / Not needed / A person checks), the API's sentence (data), who clears it, the
 * evidence (its record), the law (LawRef with the plain words in the page's language) and Fix (the owning page; held with the
 * reason while that page is not built). "Fix the first missing item" is the primary. J / K walk the cells of the row (the
 * DetailModal's own walk), ⇧J / ⇧K the rows; Esc closes.
 */
export function CellModal({ model, actions }: { model: StatusModel; actions?: StatusActions | undefined }) {
  const t = useT('compliance-status')
  const ds = useDsWords()
  const locale = useLocale()
  const cell = model.cell
  const board = model.board.status === 'ready' ? model.board.value : null
  const markets = board?.markets ?? []
  const codes = markets.map((market) => market.code)
  const rows: BoardRow[] = board ? board.rows : []
  const walk = cell ? cellWalk(rows, codes, cell.at) : null
  const latest = useRef({ walk, actions })
  latest.current = { walk, actions }

  // ⇧J / ⇧K: the same market in the next / previous row (J / K are the DetailModal's own walk along the row), caught first.
  useEffect(() => {
    if (!cell) return
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return
      const key = event.key.toLowerCase()
      const to = key === 'j' ? latest.current.walk?.down : key === 'k' ? latest.current.walk?.up : null
      if (key === 'j' || key === 'k') {
        // The DetailModal's own J / K reads the key without Shift: ⇧J / ⇧K stop here (capture), before it.
        event.preventDefault()
        event.stopPropagation()
        if (to) latest.current.actions?.onCell?.(to)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cell])

  if (!cell) return null
  const read = cell.read
  const detail: CellDetail | null = read.status === 'ready' ? read.value : null
  const row = rows.find((entry) => entry.style.id === cell.at.styleId) ?? null
  const styleCode = detail?.style.code ?? row?.style.code ?? ''
  const market = marketName(cell.at.market, detail ? [detail.market] : markets, locale)
  const items = detail?.items ?? []
  const firstMissing = items.find((item) => item.state === 'MISSING') ?? null
  const firstHref = firstMissing ? fixHref(firstMissing.fixPlace, model.prefix, model.can) : null
  const firstHeld = !firstMissing ? t('cell.nothingMissing') : firstHref ? null : t(fixHeld(firstMissing.fixPlace, model.can) ?? 'fix.held.settings')

  const checks: CheckItem[] = items.map((item: CellItem) => {
    const href = fixHref(item.fixPlace, model.prefix, model.can)
    const held = href ? null : fixHeld(item.fixPlace, model.can)
    const plain = inLanguage(item.requirement.explanationI18n, locale, '')
    return {
      id: `${item.requirement.code}-${item.check}`,
      state: LINE_CHECK[item.state],
      name: `${inLanguage(item.requirement.nameI18n, locale, item.requirement.name)} (${item.requirement.code})`,
      detail: (
        <span className="fw-cs-check">
          <span className="fw-cs-api">{item.message}</span>
          <span className="fw-cs-check-facts">
            <span>{t('cell.who', { who: t(`who.${item.who}`) })}</span>
            {item.requirement.blocks.length > 0 ? <span>{t('cell.blocks', { gates: item.requirement.blocks.map((gate) => t(`gate.${gate}`)).join(', ') })}</span> : <span>{t('cell.blocksNone')}</span>}
            {item.requirement.lockedBlocks.length > 0 ? <span>{t('cell.locked', { gates: item.requirement.lockedBlocks.map((gate) => t(`gate.${gate}`)).join(', ') })}</span> : null}
            {item.evidence ? (
              <Link className="fw-cs-link" href={recordHref(item.evidence, model.prefix)}>
                {t('cell.evidence', { label: item.evidence.label })}
              </Link>
            ) : null}
            {item.requirement.legalReference ? <LawRef law={item.requirement.legalReference} plain={plain || t('cell.lawPlain')} labels={ds.lawRef} /> : null}
          </span>
          {item.state !== 'OK' && item.state !== 'NOT_NEEDED' && item.fix ? <span className="fw-cs-muted">{t('cell.how', { how: item.fix })}</span> : null}
        </span>
      ),
      ...(item.state === 'MISSING' || item.state === 'EXPIRING' || item.state === 'MANUAL' ? { fix: href ? { label: t(`fixPlace.${item.fixPlace}`), href } : <span className="fw-cs-muted">{t(held ?? 'fix.held.settings')}</span> } : {}),
    }
  })

  const navIds = codes.map((code) => `${cell.at.styleId}|${code}`)
  const states = { ...ds.checkList.states, pass: t('line.OK'), fail: t('line.MISSING'), warning: t('line.EXPIRING'), skipped: t('line.NOT_NEEDED'), unknown: t('line.MANUAL') }
  return (
    <DetailModal
      open
      onClose={() => actions?.onCell?.(null)}
      title={t('cell.title', { style: styleCode, market })}
      subtitle={detail ? `${detail.style.name} · ${PPE_CATEGORIES.includes(detail.style.ppeCategory) ? t(`ppe.${detail.style.ppeCategory}`) : detail.style.ppeCategory}` : undefined}
      meta={detail ? <CellMark cell={detail.cell} /> : undefined}
      loading={read.status === 'loading' || read.status === 'idle'}
      error={read.status === 'error' ? t('cell.failed') : undefined}
      onRetry={() => actions?.onRetry?.('cell')}
      nav={{ ids: navIds, current: `${cell.at.styleId}|${cell.at.market}`, onGo: (id) => actions?.onCell?.({ styleId: cell.at.styleId, market: id.split('|')[1] ?? cell.at.market }), noun: t('cell.noun') }}
      footer={
        <>
          <span className="fw-cs-muted fw-cs-keys">{t('cell.keys')}</span>
          <Button onClick={() => actions?.onCell?.(null)}>{t('common.close')}</Button>
          <Button variant="primary" heldReason={firstHeld} onClick={() => (firstHref ? actions?.onGo?.(firstHref) : undefined)}>
            {t('cell.fixFirst')}
          </Button>
        </>
      }
    >
      {detail ? (
        <div className="fw-cs-cellbody">
          {detail.cell.blockedGates.length > 0 ? (
            <p className="fw-cs-note" role="note">
              <Tag tone="danger">{t('cell.BLOCKED')}</Tag> {t('cell.blockedAt', { gates: detail.cell.blockedGates.map((gate) => t(`gate.${gate}`)).join(', ') })}
            </p>
          ) : null}
          <p className="fw-cs-hint">{t('cell.intro', { market })}</p>
          <CheckList label={t('cell.listLabel', { style: styleCode, market })} checks={checks} summary labels={{ ...ds.checkList, states }} />
          {!detail.market.switchedOn ? <p className="fw-cs-hint">{t('cell.marketOff')}</p> : null}
          <p className="fw-cs-hint">{t('cell.notSold')}</p>
        </div>
      ) : null}
    </DetailModal>
  )
}
