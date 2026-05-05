/**
 * Phase B step config — multi-channel rebuild.
 *
 * New step order moves Channels & Markets to position 1 (so the
 * user picks their targets up front and every downstream step
 * operates against that set), pushes Identifiers down to 3 because
 * GTIN rules depend on the chosen category, and reflows the rest
 * to land Submission at 11.
 */

export interface StepConfig {
  id: number
  title: string
  shortLabel: string
  description: string
  /** Marker for the Phase / commit that fills this step's component
   *  in. Steps that already shipped reference their original phase;
   *  Phase B reorders them. */
  filledIn:
    | '5.4'
    | '5.5'
    | 'Phase 6'
    | 'Phase B'
    | 'Phase C'
    | 'Phase D'
    | 'Phase E'
    | 'Phase F'
    | 'Phase G'
    | 'Phase H'
    | 'Phase I'
    | 'Phase J'
    | 'TT'
  preview: string
}

// TT — Setup pre-step. Shown only in create-flow (when the user
// arrives via /products/new — the wizard advances from id 0 to 1
// after the master row is initialised). Existing wizards skip it
// because their currentStep starts at 1.
export const SETUP_STEP: StepConfig = {
  id: 0,
  title: 'Setup',
  shortLabel: 'Setup',
  description: 'Parent or variant? SKU? Master name and base price',
  filledIn: 'TT',
  preview:
    'New-product entry: pick parent or child (parent gets variants in Step 4; child links to an existing parent SKU), set the master SKU, name and base price.',
}

export const STEPS: StepConfig[] = [
  {
    id: 1,
    title: 'Channels & Markets',
    shortLabel: 'Channels',
    description: 'Pick the platforms and marketplaces to publish to',
    filledIn: 'Phase B',
    preview:
      'Multi-select across Amazon, eBay, Shopify, WooCommerce. Per-platform marketplace chips (IT, DE, FR, ES, UK). Connection status indicator per platform — disconnected channels are flagged before you commit.',
  },
  {
    id: 2,
    title: 'Product Type',
    shortLabel: 'Type',
    description: 'Pick the category for each selected channel',
    filledIn: 'Phase 6',
    preview:
      'Per-channel category picker: Amazon productTypes from cached schema, eBay categories from Taxonomy API (Phase 2A). AI-suggested matches with rule-based fallback when no API key is present.',
  },
  {
    id: 3,
    title: 'Identifiers',
    shortLabel: 'Identifiers',
    description: 'UPC / EAN / GTIN — or exemption (inline if needed)',
    filledIn: '5.4',
    preview:
      'Smart UPC/GTIN detection with three exemption paths. The exemption form is inlined below when "apply now" is picked — no separate step.',
  },
  {
    id: 4,
    title: 'Variations',
    shortLabel: 'Variations',
    description: 'Per-platform variation themes',
    filledIn: 'Phase E',
    preview:
      'Common themes (intersection across selected platforms) shown prominently; platform-specific themes as alternatives. Mirror from another channel or define custom themes when the schema is unavailable.',
  },
  {
    id: 5,
    title: 'Required Attributes',
    shortLabel: 'Attributes',
    description: 'Multi-channel union with per-variant + per-channel overrides',
    filledIn: 'Phase D',
    preview:
      'Union of required (and curated optional) attributes across every selected channel, with per-field tags showing which channels need it. Smart defaults from the master product; per-channel and per-variant overrides for fields that vary.',
  },
  {
    id: 6,
    title: 'Images',
    shortLabel: 'Images',
    description: 'Multi-scope, variation-aware, drag-to-reorder',
    filledIn: 'Phase F',
    preview:
      'Image set scoped GLOBAL → PLATFORM → MARKETPLACE with optional variation specificity. Drag-to-reorder, primary picker, per-channel validation overlay (Amazon white-bg + 1000px, eBay relaxed, Shopify any).',
  },
  {
    id: 7,
    title: 'Pricing',
    shortLabel: 'Pricing',
    description: 'Base price + per-marketplace overrides',
    filledIn: 'Phase H',
    preview:
      'Base price with override grid per (platform, marketplace). Per-channel fee + currency display, margin calculator, repricing-band warnings.',
  },
  {
    id: 8,
    title: 'Review',
    shortLabel: 'Review',
    description: 'Multi-channel summary before submit',
    filledIn: 'Phase I',
    preview:
      'Per-channel cards with prepared payload, validation status, and conflict detection across channels. Hard validation per channel before Submit unlocks.',
  },
  {
    id: 9,
    title: 'Submit',
    shortLabel: 'Submit',
    description: 'Parallel publish with retry-failed-only',
    filledIn: 'Phase J',
    preview:
      'Parallel orchestration to all selected channels, status polling every 3s, retry-failed-individually so successful channels stay live while you fix the failures.',
  },
]

export function findStep(id: number): StepConfig | undefined {
  return STEPS.find((s) => s.id === id)
}

export const TOTAL_STEPS = STEPS.length
