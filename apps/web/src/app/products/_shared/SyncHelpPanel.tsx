'use client'

/**
 * G.4 — collapsible "how it all syncs" explainer for the flat-file editors.
 *
 * Teaches a beginner the two things that are invisible in a grid of cells:
 *  - inventory: FBA (Amazon-managed) vs FBM (your warehouse, a shared pool across
 *    eBay/Shopify so a sale on any channel updates availability everywhere)
 *  - images: where they actually live (the product editor's Images tab) and the
 *    per-channel rules (Amazon global-per-ASIN; eBay per-colour axis).
 *
 * Channel-aware copy; collapsed by default so it never gets in an expert's way.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, Info, Package, Image as ImageIcon } from 'lucide-react'

export function SyncHelpPanel({ channel }: { channel: 'amazon' | 'ebay' }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-blue-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-blue-500 shrink-0" />}
        <Info className="w-4 h-4 text-blue-500 shrink-0" />
        <span className="text-xs font-medium text-blue-800 dark:text-blue-300">How inventory &amp; images sync across channels</span>
        <span className="ml-auto text-[10px] text-blue-400 dark:text-blue-500">{open ? 'Hide' : 'Learn how'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0.5 space-y-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          <div className="flex gap-2">
            <Package className="w-4 h-4 text-tertiary shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-slate-700 dark:text-slate-200 mb-0.5">Inventory</p>
              {channel === 'amazon' ? (
                <p>
                  Most Amazon products are <strong>FBA</strong> (Amazon holds &amp; ships the stock): the quantity is greyed out here, because writing one would flip the listing to merchant-fulfilled. Products you ship yourself are <strong>FBM</strong> — their quantity comes from your <strong>warehouse</strong>, which is a <strong>shared pool with eBay &amp; Shopify</strong>. Sell a unit on any channel and the available quantity drops on all of them automatically.
                </p>
              ) : (
                <p>
                  eBay listings ship from your own <strong>warehouse</strong>, and that warehouse is a <strong>shared pool</strong> across eBay, Shopify and any merchant-fulfilled Amazon listings. Sell a unit on any channel and availability drops everywhere automatically — no manual re-counting. The shared <em>Quantity</em> applies to every market; fill a per-market column only when you want to override that one market.
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <ImageIcon className="w-4 h-4 text-tertiary shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-slate-700 dark:text-slate-200 mb-0.5">Images</p>
              {channel === 'amazon' ? (
                <p>
                  Amazon images are <strong>global per ASIN</strong> — one set is shared across every market (only A+ Content differs per market). Add or reorder them per colour in the product editor&rsquo;s <strong>Images</strong> tab, not here.
                </p>
              ) : (
                <p>
                  eBay images attach per variation along the <strong>colour axis</strong>. Manage them in the product editor&rsquo;s <strong>Images</strong> tab (the Colour&times;Slot matrix), which publishes the right photo set for each variation.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
