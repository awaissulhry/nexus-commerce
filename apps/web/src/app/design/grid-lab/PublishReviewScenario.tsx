'use client'

/**
 * `?tab=publish` — the Publish review's one table (grid audit wave 3) inside the Publish window's own surface (DS Modal
 * `xxl`), from a frozen fixture shaped like a real GALE family on three Amazon markets: a Partial update with a price
 * that differs on the channel, a Full update with the values it removes, a Delete, a product left out, a problem, a
 * market still checking and one that could not be read. A local box cannot read the channels (their keys are sealed),
 * so the window's own review cannot be opened here; this is the table and the window as they draw, with live ticks.
 */
import { useMemo, useState } from 'react'
import type { StudioPublishChange } from '@nexus/shared/studio-publication'
import { Button, SegmentedControl } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import type { ActionPlanRow } from '@/app/products/_publication/dialog/actionPlan'
import { ReviewTable, type ReviewTableMarketProps } from '@/app/products/_publication/dialog/ReviewTable'

const NOW = Date.parse('2026-10-13T09:00:00Z')

const row = (over: Partial<ActionPlanRow> & Pick<ActionPlanRow, 'key' | 'productId' | 'sku'>): ActionPlanRow => ({
  kind: 'content', what: { column: 'send', mode: 'partial', setAt: null, setByName: null }, action: null, sent: '', warning: null,
  checkedAtSend: null, notSent: null, setBy: null, stale: false, tick: 'on', tickable: true, danger: false, changeIds: [],
  defaultFieldIds: [], fields: { ticked: 0, total: 0 }, creates: null, notListed: false, ...over,
})
const change = (over: Partial<StudioPublishChange> & Pick<StudioPublishChange, 'id' | 'productId' | 'sku' | 'label'>): StudioPublishChange => ({
  field: over.id.split(':')[1] ?? 'field', current: { state: 'value', value: '' }, lastAccepted: { state: 'value', value: '' }, channel: { state: 'value', value: '' },
  status: 'SEND', localChanged: true, channelChanged: false, selectable: true, selectedByDefault: true, reason: '', operation: 'replace', ...over,
})

const TITLE_NEW = 'GALE Giacca moto uomo in tessuto traspirante con protezioni CE livello 2 su spalle e gomiti, impermeabile, nera'
const TITLE_OLD = 'GALE Giacca moto uomo tessuto con protezioni CE, nera'

const IT_CHANGES: StudioPublishChange[] = [
  change({ id: 'm:title', productId: 'm', sku: 'GALE-BLACK-M', label: 'Title', current: { state: 'value', value: TITLE_NEW }, channel: { state: 'value', value: TITLE_OLD } }),
  change({ id: 'm:bullets', productId: 'm', sku: 'GALE-BLACK-M', label: 'Bullet points',
    current: { state: 'value', value: ['Tessuto traspirante con membrana impermeabile', 'Protezioni CE livello 2 su spalle e gomiti', 'Predisposizione per paraschiena'] },
    channel: { state: 'value', value: ['Tessuto traspirante', 'Protezioni CE'] } }),
  change({ id: 'm:price', productId: 'm', sku: 'GALE-BLACK-M', label: 'Price', status: 'DIFFERS', current: { state: 'value', value: '149.00' }, channel: { state: 'value', value: '129.00' },
    replaces: { kind: 'channel_changed', channel: '129.00', nexus: '149.00', sentence: 'Changed on Amazon since the last publish. Amazon has 129.00 — Publish sets 149.00.', note: 'Amazon’s Automate Pricing can change it again.' } }),
  change({ id: 'm:brand', productId: 'm', sku: 'GALE-BLACK-M', label: 'Brand', status: 'SAME' }),
  change({ id: 'l:title', productId: 'l', sku: 'GALE-BLACK-L', label: 'Title', locked: true, current: { state: 'value', value: TITLE_NEW }, channel: { state: 'value', value: TITLE_OLD } }),
  change({ id: 'l:material', productId: 'l', sku: 'GALE-BLACK-L', label: 'Material', locked: true, current: { state: 'value', value: { outer: 'Polyester 600D', lining: 'Mesh' } }, channel: { state: 'absent' } }),
]

function fixture(): Omit<ReviewTableMarketProps, 'onTicksChange'>[] {
  return [
    {
      key: 'amazon-it', label: 'Amazon · IT', channel: 'AMAZON',
      rows: [
        row({ key: 'life:s', productId: 's', sku: 'GALE-BLACK-S', kind: 'lifecycle', action: 'delete', danger: true, what: { column: 'send', mode: 'delete', setAt: '2026-10-13T08:30:00Z', setByName: 'Awais' },
          sent: 'Deletes GALE-BLACK-S on Amazon · IT.', warning: 'Amazon holds 12 sellable FBA units of it. Pan-European FBA moves units between markets.', setBy: 'Set by Awais · 30 minutes ago' }),
        row({ key: 'content:l', productId: 'l', sku: 'GALE-BLACK-L', what: { column: 'send', mode: 'full', setAt: null, setByName: null }, sent: 'Everything is sent.', changeIds: ['l:title', 'l:material'], fields: { ticked: 2, total: 2 } }),
        row({ key: 'content:m', productId: 'm', sku: 'GALE-BLACK-M', sent: '3 of 3 fields · 1 replaces an Amazon value', tick: 'on', changeIds: ['m:title', 'm:bullets', 'm:price', 'm:brand'], defaultFieldIds: ['m:title', 'm:bullets', 'm:price'], fields: { ticked: 3, total: 3 } }),
        row({ key: 'held:xl', productId: 'xl', sku: 'GALE-BLACK-XL', kind: 'held', what: { column: 'status', target: 'not_listed', state: 'not_listed', setAt: null, setByName: null },
          sent: 'Its Status is Not listed, so Publish leaves it out.', notSent: 'Its Status is Not listed, so Publish leaves it out.', tick: 'none', tickable: false, notListed: true }),
      ],
      review: {
        id: 'review-it', scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'lab' }, changes: IT_CHANGES,
        removals: [{ productId: 'l', sku: 'GALE-BLACK-L', field: 'bullets', label: 'Bullet 5', value: 'Garanzia 2 anni. Spedizione gratuita in 24 ore con Amazon Prime. Reso gratuito entro 30 giorni dalla consegna, senza domande e con rimborso completo.' }],
        issues: [{ severity: 'error', sku: 'GALE-BLACK-XS', message: 'GALE-BLACK-XS: Bullet 1 is longer than 500 characters (612).', detail: 'Amazon: The value for bullet_point exceeds the maximum length of 500 characters for this product type (JACKET).' }],
      },
      selectedIds: ['m:title', 'm:bullets', 'm:price', 'l:title', 'l:material'], lifecycleIds: ['life:s'],
    },
    { key: 'amazon-de', label: 'Amazon · DE', channel: 'AMAZON', rows: [], review: null, selectedIds: [], lifecycleIds: [],
      state: { tone: 'danger', text: 'Could not check: Amazon did not answer in time (SP-API 503).', action: 'check' } },
    { key: 'amazon-fr', label: 'Amazon · FR', channel: 'AMAZON', rows: [], review: null, selectedIds: [], lifecycleIds: [],
      state: { tone: 'info', text: 'Checking…. Reading the saved values and the channel.' } },
  ]
}

export function PublishReviewScenario() {
  const [open, setOpen] = useState(true)
  const [view, setView] = useState<'all' | 'one'>('all')
  const [ticks, setTicks] = useState<Record<string, { selectedIds: string[]; lifecycleIds: string[] }>>({})
  const markets = useMemo<ReviewTableMarketProps[]>(() => fixture().map(m => ({
    ...m, ...(ticks[m.key] ?? {}), onTicksChange: next => setTicks(prev => ({ ...prev, [m.key]: next })),
  })), [ticks])
  const shown = view === 'all' ? markets : markets.slice(0, 1)
  return <>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Open the Publish review</Button>
    </div>
    <Modal open={open} onClose={() => setOpen(false)} size="xxl" title="Publish product" subtitle="GALE-BLACK · Saved product information and included variants"
      footer={<><Button size="sm" onClick={() => setOpen(false)}>Cancel</Button><Button size="sm" variant="primary">Publish 7 changes to 1 market · skip 2</Button></>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <SegmentedControl ariaLabel="View" size="sm" value={view} onChange={v => setView(v as 'all' | 'one')}
          options={[{ value: 'all', label: 'All markets' }, { value: 'one', label: 'Amazon · IT' }]} />
        <ReviewTable allMarkets={view === 'all'} markets={shown} locked={false} now={NOW} ariaLabel="Changes in this publish"
          onCheckAgain={() => undefined} onOpen={() => setView('one')} />
      </div>
    </Modal>
  </>
}
