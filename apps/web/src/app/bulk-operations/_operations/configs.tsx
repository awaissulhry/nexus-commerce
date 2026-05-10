'use client'

/**
 * W1.7 — bulk-operation configs lifted out of BulkOperationModal.tsx
 * (which crossed 1,750 LOC at audit time). Each entry encapsulates one
 * OperationType: its toolbar label, description, default payload,
 * validity check, and parameter form.
 *
 * SCHEMA_FIELD_UPDATE is *not* here — that operation uses a different
 * backend endpoint (POST /api/products/bulk-schema-update) and lives
 * inline in the modal because its UI is dynamically driven by the
 * marketplace schema response.
 *
 * Adding a new operation:
 *   1. Append a config object below.
 *   2. Add the actionType to BulkActionType in bulk-action.service.ts
 *      and to KNOWN_BULK_ACTION_TYPES (W1.2 keeps these in lockstep).
 *   3. Implement the handler branch in BulkActionService.processItem.
 */

import type { OperationConfig } from './types'
import { Field, OverrideNumber, BoolField, inputCls } from './_helpers'

export const OPERATIONS: OperationConfig[] = [
  {
    type: 'PRICING_UPDATE',
    label: 'Adjust price',
    description:
      'Set absolute prices, apply percentage adjustments, or shift by a fixed amount across matching variations.',
    initialPayload: { adjustmentType: 'PERCENT', value: 0 },
    isPayloadValid: (p) =>
      typeof p.adjustmentType === 'string' &&
      typeof p.value === 'number' &&
      !Number.isNaN(p.value),
    renderParams: (p, set) => (
      <>
        <Field label="Adjustment">
          <select
            value={(p.adjustmentType as string) ?? 'PERCENT'}
            onChange={(e) =>
              set({ ...p, adjustmentType: e.target.value as string })
            }
            className={inputCls}
          >
            <option value="ABSOLUTE">Set to absolute amount</option>
            <option value="DELTA">Add / subtract fixed amount</option>
            <option value="PERCENT">Change by percentage</option>
          </select>
        </Field>
        <Field
          label={
            p.adjustmentType === 'PERCENT'
              ? 'Percentage (e.g. 5 = +5%, -10 = -10%)'
              : p.adjustmentType === 'DELTA'
                ? 'Amount (e.g. 5 = +€5, -2.50 = -€2.50)'
                : 'New price (€)'
          }
        >
          <input
            type="number"
            step="0.01"
            value={(p.value as number) ?? 0}
            onChange={(e) =>
              set({ ...p, value: parseFloat(e.target.value) || 0 })
            }
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Floor (optional)">
            <input
              type="number"
              step="0.01"
              value={(p.minPrice as number) ?? ''}
              onChange={(e) =>
                set({
                  ...p,
                  minPrice: e.target.value
                    ? parseFloat(e.target.value)
                    : undefined,
                })
              }
              placeholder="Skip if below"
              className={inputCls}
            />
          </Field>
          <Field label="Ceiling (optional)">
            <input
              type="number"
              step="0.01"
              value={(p.maxPrice as number) ?? ''}
              onChange={(e) =>
                set({
                  ...p,
                  maxPrice: e.target.value
                    ? parseFloat(e.target.value)
                    : undefined,
                })
              }
              placeholder="Skip if above"
              className={inputCls}
            />
          </Field>
        </div>
      </>
    ),
  },
  {
    type: 'INVENTORY_UPDATE',
    label: 'Update stock',
    description: 'Set stock to a value or adjust by a delta.',
    initialPayload: { adjustmentType: 'ABSOLUTE', value: 0 },
    isPayloadValid: (p) =>
      typeof p.adjustmentType === 'string' &&
      typeof p.value === 'number' &&
      !Number.isNaN(p.value),
    renderParams: (p, set) => (
      <>
        <Field label="Mode">
          <select
            value={(p.adjustmentType as string) ?? 'ABSOLUTE'}
            onChange={(e) =>
              set({ ...p, adjustmentType: e.target.value as string })
            }
            className={inputCls}
          >
            <option value="ABSOLUTE">Set to value</option>
            <option value="DELTA">Add / subtract</option>
          </select>
        </Field>
        <Field label="Quantity">
          <input
            type="number"
            step="1"
            value={(p.value as number) ?? 0}
            onChange={(e) =>
              set({ ...p, value: parseInt(e.target.value, 10) || 0 })
            }
            className={inputCls}
          />
        </Field>
      </>
    ),
  },
  {
    type: 'STATUS_UPDATE',
    label: 'Change status',
    description: 'Set product status (DRAFT / ACTIVE / INACTIVE).',
    initialPayload: { status: 'ACTIVE' },
    isPayloadValid: (p) =>
      ['DRAFT', 'ACTIVE', 'INACTIVE'].includes(p.status as string),
    renderParams: (p, set) => (
      <Field label="New status">
        <select
          value={(p.status as string) ?? 'ACTIVE'}
          onChange={(e) => set({ ...p, status: e.target.value })}
          className={inputCls}
        >
          <option value="DRAFT">Draft</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </Field>
    ),
  },
  {
    // E.7 — Per-marketplace ChannelListing override updates. Targets
    // ChannelListing rows directly, scoped by (channel, marketplace) +
    // optional brand / productType / status filters. Use case: "set
    // quantity buffer = 5 across all Amazon DE listings", "toggle
    // followMasterPrice = false for FR listings to make pricing
    // marketplace-local", etc.
    type: 'MARKETPLACE_OVERRIDE_UPDATE',
    label: 'Per-marketplace overrides',
    description:
      'Apply per-marketplace overrides directly on ChannelListing rows. Pick one or more fields to update — empty fields are left untouched.',
    initialPayload: {},
    isPayloadValid: (p) => {
      // At least one override field must be set. Empty payload would be
      // a no-op and the backend rejects it.
      const keys = [
        'priceOverride',
        'quantityOverride',
        'stockBuffer',
        'followMasterTitle',
        'followMasterDescription',
        'followMasterPrice',
        'followMasterQuantity',
        'followMasterImages',
        'followMasterBulletPoints',
        'isPublished',
        'pricingRule',
        'priceAdjustmentPercent',
      ]
      return keys.some((k) => k in p)
    },
    renderParams: (p, set) => {
      const onNumberToggle = (key: string, current: unknown) =>
        key in p
          ? (() => {
              const next = { ...p }
              delete next[key]
              set(next)
            })()
          : set({ ...p, [key]: current })
      const onBoolToggle = (key: string) =>
        key in p
          ? (() => {
              const next = { ...p }
              delete next[key]
              set(next)
            })()
          : set({ ...p, [key]: true })
      return (
        <>
          <div className="text-sm text-slate-500 mb-1">
            Tick a field to include it in this bulk update. Untouched fields
            keep their existing per-listing values.
          </div>

          <OverrideNumber
            label="Price override (€)"
            hint="Sets ChannelListing.priceOverride. Use empty to clear."
            field="priceOverride"
            payload={p}
            onToggle={() => onNumberToggle('priceOverride', null)}
            onChange={(v) => set({ ...p, priceOverride: v })}
          />

          <OverrideNumber
            label="Quantity override"
            hint="Sets ChannelListing.quantityOverride. Use empty to clear."
            field="quantityOverride"
            payload={p}
            onToggle={() => onNumberToggle('quantityOverride', null)}
            onChange={(v) => set({ ...p, quantityOverride: v })}
            integer
          />

          <OverrideNumber
            label="Stock buffer"
            hint="Reserved units; marketplace sees (actualStock − stockBuffer)."
            field="stockBuffer"
            payload={p}
            onToggle={() => onNumberToggle('stockBuffer', 0)}
            onChange={(v) => set({ ...p, stockBuffer: v ?? 0 })}
            integer
          />

          <div className="border border-slate-200 rounded-md p-2 space-y-1">
            <div className="text-sm uppercase tracking-wide text-slate-500 font-semibold mb-1">
              SSOT toggles
            </div>
            {[
              ['followMasterTitle', 'Follow master title'],
              ['followMasterDescription', 'Follow master description'],
              ['followMasterPrice', 'Follow master price'],
              ['followMasterQuantity', 'Follow master quantity'],
              ['followMasterImages', 'Follow master images'],
              ['followMasterBulletPoints', 'Follow master bullet points'],
              ['isPublished', 'Publish to marketplace'],
            ].map(([key, label]) => (
              <BoolField
                key={key}
                label={label}
                field={key}
                payload={p}
                onToggle={() => onBoolToggle(key)}
                onChange={(v) => set({ ...p, [key]: v })}
              />
            ))}
          </div>

          <div className="border border-slate-200 rounded-md p-2 space-y-1">
            <div className="text-sm uppercase tracking-wide text-slate-500 font-semibold mb-1">
              Pricing rule
            </div>
            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={'pricingRule' in p}
                onChange={(e) => {
                  if (e.target.checked) set({ ...p, pricingRule: 'FIXED' })
                  else {
                    const next = { ...p }
                    delete next.pricingRule
                    delete next.priceAdjustmentPercent
                    set(next)
                  }
                }}
              />
              <span>Set pricing rule</span>
            </label>
            {'pricingRule' in p && (
              <>
                <select
                  value={(p.pricingRule as string) ?? 'FIXED'}
                  onChange={(e) =>
                    set({ ...p, pricingRule: e.target.value })
                  }
                  className={inputCls}
                >
                  <option value="FIXED">Fixed price</option>
                  <option value="MATCH_AMAZON">Match Amazon Buy Box</option>
                  <option value="PERCENT_OF_MASTER">Percent of master</option>
                </select>
                {p.pricingRule === 'PERCENT_OF_MASTER' && (
                  <input
                    type="number"
                    step="0.1"
                    value={
                      (p.priceAdjustmentPercent as number | undefined) ?? 0
                    }
                    onChange={(e) =>
                      set({
                        ...p,
                        priceAdjustmentPercent:
                          parseFloat(e.target.value) || 0,
                      })
                    }
                    placeholder="Adjustment % (e.g. 10 for +10%)"
                    className={inputCls}
                  />
                )}
              </>
            )}
          </div>
        </>
      )
    },
  },
  {
    type: 'ATTRIBUTE_UPDATE',
    label: 'Set attribute',
    description:
      'Set a single key inside variationAttributes. The new value shallow-merges into existing attributes — other keys are preserved.',
    initialPayload: { attributeName: '', value: '' },
    isPayloadValid: (p) =>
      typeof p.attributeName === 'string' &&
      (p.attributeName as string).trim().length > 0,
    renderParams: (p, set) => (
      <>
        <Field label="Attribute name">
          <input
            type="text"
            value={(p.attributeName as string) ?? ''}
            onChange={(e) => set({ ...p, attributeName: e.target.value })}
            placeholder="e.g. material, fit"
            className={inputCls}
          />
        </Field>
        <Field label="Value">
          <input
            type="text"
            value={(p.value as string) ?? ''}
            onChange={(e) => set({ ...p, value: e.target.value })}
            placeholder="any value"
            className={inputCls}
          />
        </Field>
      </>
    ),
  },
  // P1 #34b — LISTING_SYNC. The handler in bulk-action.service.ts
  // enqueues OutboundSyncQueue rows for each ChannelListing. Cron
  // worker drains. Operator picks syncType (FULL_SYNC / PRICE_UPDATE /
  // QUANTITY_UPDATE / ATTRIBUTE_UPDATE) and an optional channels
  // filter — empty filter = all channels.
  {
    type: 'LISTING_SYNC',
    label: 'Resync to channels',
    description:
      'Enqueues an outbound sync for every selected product\'s ChannelListings. Use after a master edit to push the change to Amazon / eBay / Shopify. Pick "Full sync" to push everything; "Price/Quantity/Attribute" to scope the sync to one field.',
    initialPayload: { syncType: 'FULL_SYNC', channels: [] },
    isPayloadValid: () => true,
    renderParams: (p, set) => {
      const syncType = (p.syncType as string) ?? 'FULL_SYNC'
      const channels = Array.isArray(p.channels) ? (p.channels as string[]) : []
      const toggleChannel = (c: string) => {
        const next = channels.includes(c)
          ? channels.filter((x) => x !== c)
          : [...channels, c]
        set({ ...p, channels: next })
      }
      return (
        <>
          <Field label="Sync type">
            <select
              value={syncType}
              onChange={(e) => set({ ...p, syncType: e.target.value })}
              className={inputCls}
            >
              <option value="FULL_SYNC">Full sync (every field)</option>
              <option value="PRICE_UPDATE">Price only</option>
              <option value="QUANTITY_UPDATE">Quantity only</option>
              <option value="ATTRIBUTE_UPDATE">Attributes only</option>
            </select>
          </Field>
          <Field label="Channels (empty = all)">
            <div className="flex flex-wrap gap-1.5">
              {(['AMAZON', 'EBAY', 'SHOPIFY'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleChannel(c)}
                  className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    channels.includes(c)
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                  aria-pressed={channels.includes(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </Field>
        </>
      )
    },
  },
  // ── W11 / W12 — AI + channel-batch operator surfaces ─────────────────
  // These wire the bulk-operations modal to the action handlers added
  // in W11.1-3 (AI translate / SEO regen / alt-text) and W12.4
  // (CHANNEL_BATCH). Each entry's payload shape mirrors what the
  // server-side handler validates — keep them in lockstep when adding
  // new fields.
  {
    type: 'AI_TRANSLATE_PRODUCT',
    label: 'AI · Translate copy',
    description:
      'Translate product name / description / bullet points into one or more locales. Skips operator-reviewed translations by default.',
    initialPayload: {
      targetLanguages: ['it'],
      fields: ['name', 'description', 'bulletPoints'],
      skipReviewed: true,
    },
    isPayloadValid: (p) =>
      Array.isArray(p.targetLanguages) &&
      (p.targetLanguages as unknown[]).length > 0 &&
      Array.isArray(p.fields) &&
      (p.fields as unknown[]).length > 0,
    renderParams: (p, set) => {
      const langs = (p.targetLanguages as string[] | undefined) ?? []
      const fields =
        (p.fields as string[] | undefined) ?? ['name', 'description', 'bulletPoints']
      const skipReviewed = p.skipReviewed !== false
      const toggleLang = (l: string) => {
        const next = langs.includes(l)
          ? langs.filter((x) => x !== l)
          : [...langs, l]
        set({ ...p, targetLanguages: next })
      }
      const toggleField = (f: string) => {
        const next = fields.includes(f)
          ? fields.filter((x) => x !== f)
          : [...fields, f]
        set({ ...p, fields: next })
      }
      return (
        <>
          <Field label="Target languages (ISO 639-1)">
            <div className="flex flex-wrap gap-1.5">
              {['it', 'de', 'fr', 'es', 'en', 'nl', 'sv', 'pl'].map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => toggleLang(l)}
                  className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    langs.includes(l)
                      ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                  aria-pressed={langs.includes(l)}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Fields to translate">
            <div className="flex flex-wrap gap-1.5">
              {(['name', 'description', 'bulletPoints'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => toggleField(f)}
                  className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    fields.includes(f)
                      ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                  aria-pressed={fields.includes(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </Field>
          <BoolField
            label="Skip already-reviewed translations"
            field="skipReviewed"
            payload={p}
            onToggle={() => set({ ...p, skipReviewed: !skipReviewed })}
            onChange={(v) => set({ ...p, skipReviewed: v })}
          />
        </>
      )
    },
  },
  {
    type: 'AI_SEO_REGEN',
    label: 'AI · Regenerate SEO',
    description:
      'Rewrite metaTitle / metaDescription / og pair per locale. Operator-set urlHandle / canonicalUrl are never touched.',
    initialPayload: { locales: ['en'] },
    isPayloadValid: (p) =>
      Array.isArray(p.locales) && (p.locales as unknown[]).length > 0,
    renderParams: (p, set) => {
      const locales = (p.locales as string[] | undefined) ?? []
      const toggle = (l: string) => {
        const next = locales.includes(l)
          ? locales.filter((x) => x !== l)
          : [...locales, l]
        set({ ...p, locales: next })
      }
      return (
        <Field label="Locales (BCP 47)">
          <div className="flex flex-wrap gap-1.5">
            {['en', 'it', 'de', 'fr', 'es', 'nl'].map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => toggle(l)}
                className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                  locales.includes(l)
                    ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
                aria-pressed={locales.includes(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </Field>
      )
    },
  },
  {
    type: 'AI_ALT_TEXT',
    label: 'AI · Generate alt text',
    description:
      'Write accessibility-grade alt for product images. Skips images that already have alt by default.',
    initialPayload: { onlyEmpty: true, locale: 'en' },
    isPayloadValid: (p) =>
      typeof p.locale === 'string' &&
      /^[a-z]{2}(-[a-z0-9]{2,8})?$/.test(p.locale as string),
    renderParams: (p, set) => {
      const locale = (p.locale as string) ?? 'en'
      const onlyEmpty = p.onlyEmpty !== false
      return (
        <>
          <Field label="Locale">
            <div className="flex flex-wrap gap-1.5">
              {['en', 'it', 'de', 'fr', 'es'].map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => set({ ...p, locale: l })}
                  className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    locale === l
                      ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>
          <BoolField
            label="Only generate when alt is empty"
            field="onlyEmpty"
            payload={p}
            onToggle={() => set({ ...p, onlyEmpty: !onlyEmpty })}
            onChange={(v) => set({ ...p, onlyEmpty: v })}
          />
        </>
      )
    },
  },
  {
    type: 'CHANNEL_BATCH',
    label: 'Channel batch — price / stock push',
    description:
      'Push price or stock to AMAZON / EBAY / SHOPIFY through the W12 batch service (JSON_LISTINGS_FEED, bulkOperationRunMutation, parallel-with-retry).',
    initialPayload: { channel: 'AMAZON', operation: 'price' },
    isPayloadValid: (p) =>
      (p.channel === 'AMAZON' || p.channel === 'EBAY' || p.channel === 'SHOPIFY') &&
      (p.operation === 'price' || p.operation === 'stock'),
    renderParams: (p, set) => {
      const channel = (p.channel as string) ?? 'AMAZON'
      const operation = (p.operation as string) ?? 'price'
      const marketplace = (p.marketplace as string | undefined) ?? ''
      return (
        <>
          <Field label="Channel">
            <div className="flex gap-1.5">
              {(['AMAZON', 'EBAY', 'SHOPIFY'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set({ ...p, channel: c })}
                  className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    channel === c
                      ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Operation">
            <div className="flex gap-1.5">
              {(['price', 'stock'] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => set({ ...p, operation: o })}
                  className={`h-7 px-2.5 text-sm rounded border transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${
                    operation === o
                      ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-300'
                      : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Marketplace (optional — Amazon: IT/DE/FR/ES/NL)">
            <input
              type="text"
              value={marketplace}
              onChange={(e) =>
                set({
                  ...p,
                  marketplace: e.target.value.trim() || undefined,
                })
              }
              placeholder="IT"
              className={inputCls}
            />
          </Field>
        </>
      )
    },
  },
]
