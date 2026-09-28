'use client'

/**
 * Catalog: the variation-theme pop-up on SHOPIFY (sheet pop-up rebuild P3b, slice A4 — docs/sheet-popup-editor/
 * QUALITY-PLAN-2026-09-28.md §4.11). The local copy cannot open the Shopify scope of the sheet (no Shopify keys), so the
 * channel layout is shown here on the VT.1 fixture family: free option names, an option under your own name ("Fit",
 * values from a made-up Shared attribute), "New attribute", and a product already on Shopify, which is locked.
 *
 * Every value below is MADE UP. Nothing here calls the network: "Create" answers from a stand-in.
 */
import { useState } from 'react'

import { AxesPanel } from '../grid/editors/AxesPanelEditor'
import type { OwnAxisAttributeResult, OwnAxisSourceOption, OwnAxisSourcesState } from '../grid/editors/channelAxes'
import type { VariationThemeCell } from '../grid/renderers/variationTheme'
import { GALE_SHOPIFY_DROPPED } from '../../../../../docs/fixtures/vt1/fixtures'

const FIT: OwnAxisSourceOption = { field: 'example_fit', label: 'Fit', filled: 1, of: 2, values: ['Slim'] }

const OPEN: VariationThemeCell = {
  ...GALE_SHOPIFY_DROPPED,
  ownNames: { allowed: true, maxLength: 255, reason: null },
  axes: [
    GALE_SHOPIFY_DROPPED.axes[0],
    { axisKey: 'own:shared:example_fit', familyKey: 'own:shared:example_fit', label: 'Fit', channelName: 'Fit', target: 'Fit', included: true, own: { from: 'shared', field: 'example_fit', custom: true } },
    ...GALE_SHOPIFY_DROPPED.axes.slice(1),
  ],
  valueSummary: { 'own:shared:example_fit': { values: ['Slim'], filled: 1, of: 2 } },
}

const LIVE: VariationThemeCell = {
  ...OPEN,
  locked: {
    reason: 'Live on Shopify GLOBAL (example-product). Nexus cannot change the options of a product already on Shopify yet, so its options and their order are locked here.',
    externalId: 'example-product', setChangeIs: 'in-place', orderChangeAllowed: false,
  },
}

const SOURCES: OwnAxisSourcesState = {
  state: 'ready',
  sources: [FIT],
  newAttribute: { allowed: true, reason: null, familyLabel: 'Example jackets', familyProducts: 3 },
}

/** The stand-in for `POST …/studio/own-axis-attribute`: a new, empty attribute under the typed name. */
async function createStandIn(name: string): Promise<OwnAxisAttributeResult> {
  const field = `example_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'attribute'}`
  return { outcome: 'created', source: { field, label: name.trim(), filled: 0, of: 2, values: [] } }
}

export function ShopifyOptionsExample() {
  const [open, setOpen] = useState<VariationThemeCell>(OPEN)
  const [sources, setSources] = useState<OwnAxisSourcesState>(SOURCES)
  const create = async (name: string): Promise<OwnAxisAttributeResult> => {
    const result = await createStandIn(name)
    if ('source' in result) setSources((now) => (now.state === 'ready' ? { ...now, sources: [...now.sources.filter((s) => s.field !== result.source.field), result.source] } : now))
    return result
  }
  return (
    <section style={{ display: 'grid', gap: 12, marginBottom: 24 }} aria-label="Variation theme on Shopify">
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--nds-text-3)' }}>Variation theme · Shopify options</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        {/* The sheet sizes the pop-up to the window (`editorBox`); here each takes up to 480 px of the page, never more. */}
        <div data-testid="shopify-options-open" style={{ flex: '1 1 320px', maxWidth: 480, minWidth: 0 }}>
          <AxesPanel cell={open} host="cell" ownSources={sources} onRequestOwnSources={() => undefined} onCreateOwnAttribute={create} onChange={setOpen} style={{ width: '100%' }} />
        </div>
        <div data-testid="shopify-options-live" style={{ flex: '1 1 320px', maxWidth: 480, minWidth: 0 }}>
          <AxesPanel cell={LIVE} host="cell" ownSources={SOURCES} onRequestOwnSources={() => undefined} onChange={() => undefined} style={{ width: '100%' }} />
        </div>
      </div>
    </section>
  )
}
