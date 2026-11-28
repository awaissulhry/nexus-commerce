'use client'

import type { ReactNode } from 'react'
import { PICTURE_PX, type PictureSize } from '../model'
import { orderPictureViewOf, type OrderPictureState } from '../order-picture'
import { OrderPictureWindowBody, OrderPictureWindowFoot, OrderPictureWindowView, type OrderPictureWindowModel } from './OrderPictureWindowView'
import { RecordPicture } from './RecordPicture'

/**
 * owb-b4 w4.3 — the lab of the picture parts (`/design/record-picture-parts`): the part at every size (the change log's 30 px line and
 * the message's 40 px among them; the floor's basket drawn from its host's address) and the window "The picture of the order" in its
 * states — its body and foot drawn in the page (a Modal draws only when opened), and once opened for real. Made-up data only.
 */

export interface RecordPictureLabModel {
  readonly show: 'sizes' | 'window' | 'window-open'
  /** The window's state (window cases). */
  readonly state?: OrderPictureState
  /** The window's host can upload. */
  readonly canUpload?: boolean
  /** A made-up picture address (an SVG data address). */
  readonly demo: string
}

const noop = () => undefined
const ACTIONS = { onClose: noop, onPick: noop, onFiles: noop, onSave: noop }
const SIZES: readonly PictureSize[] = ['cell', 'log', 'message', 'line', 'phone', 'lineLarge', 'board']

function Frame({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gap: 'var(--nds-space-16)', maxWidth: 560, padding: 'var(--nds-space-16)', border: '1px solid var(--nds-border-subtle)', borderRadius: 'var(--nds-radius-lg)', background: 'var(--nds-surface)' }}>{children}</div>
}

export function RecordPictureLab({ model }: { model: RecordPictureLabModel }) {
  if (model.show === 'sizes')
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--nds-space-24)', padding: 'var(--nds-space-16)' }}>
        {SIZES.map((size) => (
          <figure key={size} style={{ margin: 0, display: 'grid', justifyItems: 'center', gap: 'var(--nds-space-4)' }}>
            <RecordPicture source="order" recordId={`demo-${size}`} number="Your order 12" picture={{ styleId: 's-1', styleCode: 'STY-01', styleName: 'Demo race suit', fileId: 'f-1', small: true }} size={size} demo={model.demo} />
            <figcaption>{`${size} · ${PICTURE_PX[size]} px`}</figcaption>
          </figure>
        ))}
        <figure style={{ margin: 0, display: 'grid', justifyItems: 'center', gap: 'var(--nds-space-4)' }}>
          <RecordPicture source="basket" recordId="demo-basket" number="BSK-0042" picture={{ styleId: 's-1', styleCode: 'STY-01', styleName: 'Demo race suit', fileId: 'f-2', small: true }} size="phone" held={{ url: model.demo, expiresAt: '2099-01-01T00:00:00.000Z' }} />
          <figcaption>basket · the host&apos;s address</figcaption>
        </figure>
      </div>
    )
  const state = model.state!
  const win: OrderPictureWindowModel = { open: model.show === 'window-open', number: 'Your order 12', subject: 'Race suits for the spring', record: { source: 'order', recordId: 'demo-window', demo: model.demo }, view: orderPictureViewOf(state), canUpload: model.canUpload ?? false }
  if (model.show === 'window-open') return <OrderPictureWindowView model={win} actions={ACTIONS} />
  return (
    <Frame>
      <OrderPictureWindowBody model={win} actions={ACTIONS} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--nds-space-8)' }}>
        <OrderPictureWindowFoot view={win.view} actions={ACTIONS} />
      </div>
    </Frame>
  )
}
