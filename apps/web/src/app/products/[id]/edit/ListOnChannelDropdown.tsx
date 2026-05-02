'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Plus } from 'lucide-react'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { cn } from '@/lib/utils'

interface Props {
  productId: string
}

const AMAZON_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK', 'US'] as const
const EBAY_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const

export default function ListOnChannelDropdown({ productId }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t))
        return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const launch = (channel: string, marketplace: string) => {
    setOpen(false)
    router.push(
      `/products/${productId}/list-wizard?channel=${encodeURIComponent(
        channel,
      )}&marketplace=${encodeURIComponent(marketplace)}`,
    )
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2.5 text-[12px] font-medium rounded-md border transition-colors',
          'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus className="w-3.5 h-3.5" />
        List on Channel
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          className="absolute right-0 top-full mt-1 w-72 max-h-[400px] bg-white border border-slate-200 rounded-lg shadow-lg z-30 flex flex-col"
        >
          <div className="overflow-y-auto py-1">
            <Section label="Amazon">
              {AMAZON_MARKETS.map((mp) => (
                <MarketRow
                  key={`amazon-${mp}`}
                  code={mp}
                  label={COUNTRY_NAMES[mp] ?? mp}
                  onClick={() => launch('AMAZON', mp)}
                />
              ))}
            </Section>
            <Section label="eBay">
              {EBAY_MARKETS.map((mp) => (
                <MarketRow
                  key={`ebay-${mp}`}
                  code={mp}
                  label={COUNTRY_NAMES[mp] ?? mp}
                  onClick={() => launch('EBAY', mp)}
                />
              ))}
            </Section>
            <Section label="Other channels">
              <button
                type="button"
                onClick={() => launch('SHOPIFY', 'GLOBAL')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left text-slate-700 hover:bg-slate-50"
              >
                <span className="font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded border bg-slate-100 border-slate-200 text-slate-600">
                  SHOPIFY
                </span>
                <span>Shopify (all stores)</span>
              </button>
              <button
                type="button"
                onClick={() => launch('WOOCOMMERCE', 'GLOBAL')}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left text-slate-700 hover:bg-slate-50"
              >
                <span className="font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded border bg-slate-100 border-slate-200 text-slate-600">
                  WOO
                </span>
                <span>WooCommerce</span>
              </button>
            </Section>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

function MarketRow({
  code,
  label,
  onClick,
}: {
  code: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left text-slate-700 hover:bg-slate-50"
    >
      <span className="font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded border bg-slate-100 border-slate-200 text-slate-600">
        {code}
      </span>
      <span className="truncate">{label}</span>
    </button>
  )
}
