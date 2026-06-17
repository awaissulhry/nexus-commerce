'use client'

// EC.2.4 — Listing Essentials card.
//
// Proves the Field Source System end-to-end on three fields every
// listing has: Title, Description, Price. Becomes the visible answer
// to the operator's request that "every value should be a manual
// choice" — they can keep Manual, pull From Master, pull AI
// (stubbed), or copy From Sibling, with diff-then-apply and undo
// per field, per marketplace.
//
// This card does NOT yet drive the actual ChannelListing payload —
// that wiring lands in EC.10's save flow when the Field Source state
// hoists into platformAttributes._fieldSources. Until then the card
// is fully testable end-to-end via localStorage persistence.

import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import FieldSourceRow from '../field-source/FieldSourceRow'
import { useFieldSourceContext } from '../field-source/FieldSourceProvider'
import AiImproveModal from '../ai/AiImproveModal'
import type { FieldSource } from '../field-source/types'

interface SiblingPreview {
  marketplace: string
  title: string
  description: string
  price: number | null
}

interface Props {
  productId: string
  marketplace: string
  currency: string
  initial: {
    title: { source: FieldSource; value: string }
    description: { source: FieldSource; value: string }
    price: { source: FieldSource; value: string }
  }
  master: {
    name: string
    description: string
    price: number | null
  }
  siblings: SiblingPreview[]
}

export default function ListingEssentialsCard({
  productId,
  marketplace,
  currency,
  initial,
  master,
  siblings,
}: Props) {
  const { t } = useTranslations()
  const fsCtx = useFieldSourceContext()
  const [aiOpen, setAiOpen] = useState(false)
  // Read current title/description from the field-source store so the
  // AI modal's "before" side reflects what the operator actually sees.
  const titleState = fsCtx.read(`${marketplace}.title`, initial.title)
  const descState = fsCtx.read(`${marketplace}.description`, initial.description)
  // AI resolver is a stub for EC.2 — EC.12 wires the real list-wizard
  // backed assistant. Today it returns a deterministic transform so
  // the diff modal has something to show.
  const fakeAiTitle = (): string => {
    const base = master.name || initial.title.value || 'Listing'
    return `${base} | ${marketplace} — Fast EU shipping`
  }
  const fakeAiDesc = (): string => {
    const base = master.description || initial.description.value
    if (!base) return `Premium product. Ships from Italy. EU tracked delivery.`
    return `${base}\n\n— Ships within 24h from our Italian warehouse.\n— 30-day returns.\n— Authentic & VAT-compliant invoice included.`
  }

  // Sibling resolver picks the first marketplace that has a value.
  // EC.6 surfaces a per-sibling chooser; EC.2 keeps it deterministic.
  const pickSibling = (key: 'title' | 'description' | 'price'): string | null => {
    for (const s of siblings) {
      const v = s[key]
      if (v != null && v !== '' && v !== 0) return String(v)
    }
    return null
  }

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.ebay.essentials.title')}
        </div>
        <Badge variant="info">EC.2</Badge>
        <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto">
          {t('products.edit.cockpit.ebay.essentials.subtitle')}
        </span>
        <button
          type="button"
          onClick={() => setAiOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100"
          title={t('products.edit.cockpit.ebay.essentials.aiImproveTooltip')}
        >
          <Sparkles className="w-3 h-3" /> {t('products.edit.cockpit.ebay.essentials.aiImprove')}
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* ── Title ─────────────────────────────────────────────── */}
        <FieldSourceRow
          fieldKey={`${marketplace}.title`}
          label={t('products.edit.cockpit.ebay.essentials.titleLabel')}
          initial={initial.title}
          availableSources={['manual', 'master', 'ai', 'sibling', 'default']}
          resolveValue={(src) => {
            if (src === 'master')  return master.name
            if (src === 'ai')      return fakeAiTitle()
            if (src === 'sibling') return pickSibling('title')
            if (src === 'default') return ''
            return null
          }}
          preview={(src) => {
            if (src === 'master')  return master.name || null
            if (src === 'ai')      return fakeAiTitle().slice(0, 60) + '…'
            if (src === 'sibling') return pickSibling('title')?.slice(0, 60) ?? null
            return null
          }}
        >
          {({ value, onChange }) => (
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              maxLength={80}
              placeholder={t('products.edit.cockpit.ebay.essentials.titlePlaceholder')}
              className="w-full text-sm border border-default dark:border-slate-700 rounded px-2.5 py-1.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          )}
        </FieldSourceRow>

        {/* ── Description ───────────────────────────────────────── */}
        <FieldSourceRow
          fieldKey={`${marketplace}.description`}
          label={t('products.edit.cockpit.ebay.essentials.descriptionLabel')}
          initial={initial.description}
          availableSources={['manual', 'master', 'ai', 'sibling', 'default']}
          resolveValue={(src) => {
            if (src === 'master')  return master.description
            if (src === 'ai')      return fakeAiDesc()
            if (src === 'sibling') return pickSibling('description')
            if (src === 'default') return ''
            return null
          }}
          preview={(src) => {
            if (src === 'master')  return master.description?.slice(0, 60) ?? null
            if (src === 'ai')      return fakeAiDesc().slice(0, 60) + '…'
            if (src === 'sibling') return pickSibling('description')?.slice(0, 60) ?? null
            return null
          }}
        >
          {({ value, onChange }) => (
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              rows={4}
              placeholder={t('products.edit.cockpit.ebay.essentials.descriptionPlaceholder')}
              className="w-full text-sm border border-default dark:border-slate-700 rounded px-2.5 py-1.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          )}
        </FieldSourceRow>

        {/* ── Price ─────────────────────────────────────────────── */}
        <FieldSourceRow
          fieldKey={`${marketplace}.price`}
          label={`${t('products.edit.cockpit.ebay.essentials.priceLabel')} (${currency})`}
          initial={initial.price}
          availableSources={['manual', 'master', 'sibling', 'default']}
          resolveValue={(src) => {
            if (src === 'master')  return master.price != null ? String(master.price) : null
            if (src === 'sibling') return pickSibling('price')
            if (src === 'default') return ''
            return null
          }}
          preview={(src) => {
            if (src === 'master')  return master.price != null ? `${currency} ${master.price.toFixed(2)}` : null
            if (src === 'sibling') {
              const v = pickSibling('price')
              return v ? `${currency} ${parseFloat(v).toFixed(2)}` : null
            }
            return null
          }}
        >
          {({ value, onChange }) => (
            <input
              type="number"
              step="0.01"
              min="0"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="0.00"
              className="w-40 text-sm border border-default dark:border-slate-700 rounded px-2.5 py-1.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          )}
        </FieldSourceRow>

        <div className="text-[10.5px] text-tertiary italic pt-1 border-t border-subtle dark:border-slate-800">
          State lives in localStorage during the EC engagement, hoisted to
          ChannelListing.platformAttributes._fieldSources by EC.10&apos;s
          save flow. Per-field AI source is stubbed (deterministic);
          card-level AI improve calls the real Claude assistant.
        </div>
      </div>

      <AiImproveModal
        open={aiOpen}
        operation="essentials"
        productId={productId}
        marketplace={marketplace}
        currentEssentials={{
          title: titleState.value,
          description: descState.value,
        }}
        onApplyEssentials={(next) => {
          // Push through the Field Source store with source='ai' so
          // the source badge updates AND undo history captures the
          // prior value for one-click revert.
          if (next.title !== undefined) {
            fsCtx.applySwitch(`${marketplace}.title`, 'ai', next.title)
          }
          if (next.description !== undefined) {
            fsCtx.applySwitch(`${marketplace}.description`, 'ai', next.description)
          }
        }}
        onClose={() => setAiOpen(false)}
      />
    </Card>
  )
}
