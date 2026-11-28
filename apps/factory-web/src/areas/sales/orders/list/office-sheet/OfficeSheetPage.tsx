'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { Button, Input, SegmentedControl } from '@nexus/ui/primitives'
import { Banner } from '@nexus/ui/components'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useT } from '../../../../../lib/i18n/provider'
import { OrdersSheet } from '../../../../../lib/orders-sheet/view/OrdersSheet'
import { SheetPicturesProvider } from '../../../../../lib/orders-sheet/pictures'
import { PrintStartWindow } from '../../record/print/PrintStartWindow'
import { PrintAgainWindow } from '../../record/print/PrintAgainWindow'
import { ShipWholeOrderWindow } from '../../record/shipments/ShipWholeOrderWindow'
import { isSheetFilter } from './api'
import { NS, OFFICE_COLUMNS, filtersOf, tilesOf } from './map'
import { useOfficeSheet } from './use-office-sheet'
import { AsksWindow } from './windows/AsksWindow'
import { DeleteDraftsWindow } from './windows/DeleteDraftsWindow'
import { PickCustomerWindow } from './windows/PickCustomerWindow'
import { ReviewChangeWindow } from './windows/ReviewChangeWindow'
import { SheetPictureWindow } from './windows/SheetPictureWindow'
import { GiveDesignerWindow } from './windows/GiveDesignerWindow' // owb-of4
import { ConfirmOrderWindow } from '../../draft/ConfirmOrderWindow' // owb-of4 (lead): THE Confirm window for bulk Confirm
import './office-sheet.css'

/**
 * owb-of3 step 4 — Sales › Orders, the Sheet: the ONE orders sheet part (kind `office`) on of1's sheet read — Draft and Sent orders
 * beside the confirmed ones, the six tiles, the filters, the chips as doors, typing by L2, the customer's asks, the bulk acts. The
 * band keeps today's layout switch (Board and By promise week stay today's views) and New order; live changes wait behind
 * "N updates · Show". The S3 windows (Print and start, Print again, Ship) are the base's stubs, mounted here.
 */
export function OfficeSheetPage() {
  return (
    <WithMessages namespaces={['orders', NS, 'order-life']}>
      <Page />
    </WithMessages>
  )
}

function Page() {
  const { model, actions } = useOfficeSheet()
  const t = useT(NS)
  const o = useT('orders')
  const [q, setQ] = useState(model.q)
  const sent = useRef(model.q)
  // The search follows the typing (a short pause), into the address.
  useEffect(() => {
    if (q === sent.current) return
    const timer = setTimeout(() => {
      sent.current = q
      actions.onSearch(q)
    }, 300)
    return () => clearTimeout(timer)
  }, [q, actions])
  const shown = model.window
  const done = actions.onDone
  const close = actions.onCloseWindow

  return (
    <div className="fw-osp">
      <div className="fw-osp-head">
        <h2 className="fw-osp-title">{t('office.title')}</h2>
        <span className="fw-osp-muted" role="status">
          {o(`live.${model.live}`)}
        </span>
        <span className="fw-osp-grow" />
        <SegmentedControl
          size="sm"
          ariaLabel={o('list.layoutLabel')}
          value="list"
          onChange={(value) => actions.onLayout(value === 'board' ? 'board' : value === 'week' ? 'week' : 'list')}
          options={[
            { value: 'list', label: o('layout.list') },
            { value: 'board', label: o('layout.board') },
            { value: 'week', label: o('layout.week') },
          ]}
        />
        <Button size="sm" variant="primary" heldReason={model.manage ? null : t('office.refused.forbidden')} onClick={() => void actions.onNewOrder({ column: 'customer', value: '' })}>
          <Plus size={14} aria-hidden /> {o('list.new')}
        </Button>
      </div>

      <div className="fw-osp-tools">
        <span className="fw-osp-search">
          <Input value={q} onChange={(event) => setQ(event.target.value)} leadingIcon={<Search size={14} aria-hidden />} placeholder={t('office.search')} aria-label={t('office.search')} />
        </span>
        {model.updates > 0 && (
          <Button size="sm" variant="tonal" onClick={actions.onShowUpdates}>
            <RefreshCw size={14} aria-hidden /> {t('office.updates', { count: model.updates })}
          </Button>
        )}
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.words}
          action={
            <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
              {t('office.dismiss')}
            </Button>
          }
        />
      )}

      <SheetPicturesProvider value={model.pictures}>
        <OrdersSheet
          kind="office"
          orders={model.orders}
          columns={OFFICE_COLUMNS}
          filters={{ items: filtersOf(model.tiles, t), active: model.filter, onPick: (id) => isSheetFilter(id) && actions.onFilter(id) }}
          tiles={tilesOf(model.tiles, t, actions.onFilter)}
          onCommit={actions.onCommit}
          onOpen={actions.onOpen}
          onNewOrder={model.manage ? actions.onNewOrder : undefined}
          bulk={actions.bulk}
          live={{ lastChange: model.lastChange, flashKeys: model.flashKeys }}
          loading={model.loading}
          error={model.problem}
        />
      </SheetPicturesProvider>
      {model.more && (
        <span className="fw-osp-more">
          <Button size="sm" onClick={actions.onMore}>
            {t('office.more')}
          </Button>
        </span>
      )}

      {shown?.kind === 'pick' && <PickCustomerWindow seed={shown.seed} companyId={model.companyId} onClose={close} onDone={done} />}
      {shown?.kind === 'delete' && <DeleteDraftsWindow rows={shown.rows} onClose={close} onDone={done} />}
      {shown?.kind === 'asks' && <AsksWindow row={shown.row} onClose={close} onDone={done} />}
      {shown?.kind === 'review' && <ReviewChangeWindow row={shown.row} lineId={shown.lineId} sizes={shown.sizes} prefix={model.prefix} onClose={close} onDone={done} />}
      {shown?.kind === 'picture' && <SheetPictureWindow row={shown.row} pictures={model.pictures} onClose={close} onDone={done} />}
      {shown?.kind === 'designer' && <GiveDesignerWindow rows={shown.rows} skipped={shown.skipped} onClose={close} onDone={done} />}
      {model.confirmWindow && <ConfirmOrderWindow key={model.confirmWindow.requestId} open requestId={model.confirmWindow.requestId} onClose={actions.onConfirmClose} onConfirmed={() => actions.onConfirmed()} />}
      {shown?.kind === 'print' && <PrintStartWindow open onClose={() => done(null)} companyId={model.companyId} orderId={shown.orderId} />}
      {shown?.kind === 'printAgain' && <PrintAgainWindow open onClose={() => done(null)} companyId={model.companyId} orderId={shown.orderId} />}
      {shown?.kind === 'ship' && <ShipWholeOrderWindow open onClose={() => done(null)} companyId={model.companyId} orderId={shown.orderId} />}
    </div>
  )
}
