'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Factory, History } from 'lucide-react'
import { MetricStrip } from '@nexus/ui/components'
import { WithMessages } from '../../../../record-panels/i18n'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { formatNumber } from '../../../../lib/i18n/format'
import { StateChip } from '../../../../lib/order-cells/view/StateChip'
import { DeptStrip } from '../../../../lib/department/view/DeptStrip'
import { fixedDepartments } from '../../../../lib/department/model'
import { readSheet, type SheetRowRead, type SheetTiles } from '../../../sales/orders/list/office-sheet/api'
import { TODAY_NS, lastChangedOf, piecesByDepartmentOf, rowHrefOf, todayTilesOf } from './model'
import './orders-now.css'

type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'failed' }

const ACCENT = { neutral: 'var(--nds-text-3)', info: 'var(--nds-info)', success: 'var(--nds-success)', warning: 'var(--nds-warning)', danger: 'var(--nds-danger)' } as const

/**
 * owb-of4 step 2 — the orders on Today, above today's own lists ("Needs you": the queue, waiting-on and my asks, as they are): the six
 * tiles (doors to the Orders sheet's filters), "The factory now" (the base's DeptStrip: pieces in production by department) and "Last
 * changes" (the orders changed last, each a door). Two reads of the sheet (`GET /sales/orders/sheet`): the first page (tiles + the
 * newest changes) and the production page. A read that did not answer says so in one quiet line.
 */
export function OrdersNow() {
  return (
    <WithMessages namespaces={[TODAY_NS, 'orders-sheet', 'order-life', 'department']}>
      <Now />
    </WithMessages>
  )
}

function Now() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const t = useT(TODAY_NS)
  const sheet = useT('orders-sheet')
  const say = useT('department')
  const locale = useLocale()
  const [first, setFirst] = useState<Read<{ tiles: SheetTiles; rows: readonly SheetRowRead[] }>>({ status: 'loading' })
  const [production, setProduction] = useState<Read<{ rows: readonly SheetRowRead[]; partial: boolean }>>({ status: 'loading' })

  useEffect(() => {
    const control = new AbortController()
    readSheet(api, { life: 'all', q: '', partyId: null, cursor: null, limit: 5 }, control.signal)
      .then((answer) => !control.signal.aborted && setFirst({ status: 'ready', value: { tiles: answer.tiles, rows: answer.rows } }))
      .catch(() => !control.signal.aborted && setFirst({ status: 'failed' }))
    readSheet(api, { life: 'production', q: '', partyId: null, cursor: null, limit: 100 }, control.signal)
      .then((answer) => !control.signal.aborted && setProduction({ status: 'ready', value: { rows: answer.rows, partial: answer.nextCursor !== null } }))
      .catch(() => !control.signal.aborted && setProduction({ status: 'failed' }))
    return () => control.abort()
  }, [api])

  const departments = useMemo(() => fixedDepartments(say), [say])
  const strip = production.status === 'ready' ? piecesByDepartmentOf(production.value.rows) : null

  return (
    <section className="fw-onow" aria-label={t('orders.label')}>
      {first.status === 'failed' ? (
        <p className="fw-onow-quiet">{t('orders.tilesFailed')}</p>
      ) : first.status === 'ready' ? (
        <MetricStrip
          size="sm"
          metrics={todayTilesOf(first.value.tiles, prefix).map((tile) => ({ label: sheet(`office.tile.${tile.id}`), value: formatNumber(tile.count, locale), accent: ACCENT[tile.tone], href: tile.href, title: t('orders.tileDoor', { tile: sheet(`office.tile.${tile.id}`) }) }))}
        />
      ) : (
        <p className="fw-onow-quiet">{t('orders.reading')}</p>
      )}

      <div className="fw-onow-parts">
        <div className="fw-onow-part">
          <h3 className="fw-onow-head">
            <Factory size={16} aria-hidden /> {t('orders.factoryNow')}
          </h3>
          {production.status === 'failed' ? (
            <p className="fw-onow-quiet">{t('orders.factoryFailed')}</p>
          ) : production.status === 'loading' ? (
            <p className="fw-onow-quiet">{t('orders.reading')}</p>
          ) : strip === null ? (
            <p className="fw-onow-quiet">{t('orders.factoryNone')}</p>
          ) : (
            <>
              <DeptStrip kind="pieces" tiles={departments.filter((dept) => strip.has(dept.no)).map((dept) => ({ dept, count: strip.get(dept.no) ?? 0 }))} />
              {production.value.partial && <p className="fw-onow-quiet">{t('orders.factoryPartial')}</p>}
            </>
          )}
        </div>

        <div className="fw-onow-part">
          <h3 className="fw-onow-head">
            <History size={16} aria-hidden /> {t('orders.lastChanges')}
          </h3>
          {first.status === 'failed' ? (
            <p className="fw-onow-quiet">{t('orders.changesFailed')}</p>
          ) : first.status === 'loading' ? (
            <p className="fw-onow-quiet">{t('orders.reading')}</p>
          ) : first.value.rows.length === 0 ? (
            <p className="fw-onow-quiet">{t('orders.changesNone')}</p>
          ) : (
            <ul className="fw-onow-list">
              {lastChangedOf(first.value.rows).map((row) => (
                <li key={`${row.kind}:${row.id}`}>
                  <Link className="fw-onow-row" href={rowHrefOf(prefix, row)}>
                    <span className="fw-onow-strong">{row.number ?? sheet('part.noNumber')}</span>
                    <span className="fw-onow-ell">{row.subject ?? sheet('part.noSubject')}</span>
                    <span className="fw-onow-muted fw-onow-ell">{row.party.name}</span>
                    <StateChip life={row.life} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link className="fw-onow-more" href={`${prefix}/sales/orders`}>
            {t('orders.openSheet')}
          </Link>
        </div>
      </div>
    </section>
  )
}
