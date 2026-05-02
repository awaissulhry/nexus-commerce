'use client'

import Link from 'next/link'
import { Package } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProductRow } from '../ProductsClient'

interface Props {
  products: ProductRow[]
}

export default function GridView({ products }: Props) {
  return (
    <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  )
}

function ProductCard({ product }: { product: ProductRow }) {
  return (
    <Link
      href={`/products/${product.id}/edit`}
      className="group flex flex-col bg-white border border-slate-200 rounded-lg overflow-hidden hover:shadow-md hover:border-blue-200 transition-all"
    >
      <div className="aspect-square bg-slate-50 relative overflow-hidden">
        <CardImage src={product.imageUrl} alt={product.name} />
        <div className="absolute top-2 left-2 flex flex-col gap-1">
          <StatusBadge status={product.status} />
        </div>
      </div>
      <div className="p-3 flex flex-col gap-1 min-h-[112px]">
        <p className="text-[11px] font-mono text-slate-500 truncate">
          {product.sku}
        </p>
        <h3 className="text-[13px] font-medium text-slate-900 leading-snug line-clamp-2">
          {product.name}
        </h3>
        <p className="text-[11px] text-slate-500 truncate">
          {product.brand ?? '—'}
        </p>
        <div className="flex items-center justify-between mt-auto pt-2 border-t border-slate-100">
          <div className="flex flex-col">
            <span className="text-[14px] font-semibold tabular-nums text-slate-900">
              €{product.basePrice.toFixed(2)}
            </span>
            <StockIndicator stock={product.totalStock} />
          </div>
          <ChannelDots channels={product.syncChannels} />
        </div>
      </div>
    </Link>
  )
}

function CardImage({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return <Placeholder />
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={(e) => {
        // Swap to the placeholder element on load failure.
        const img = e.currentTarget
        const fallback = img.nextElementSibling as HTMLElement | null
        img.style.display = 'none'
        if (fallback) fallback.style.display = 'flex'
      }}
      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
    />
  )
}

function Placeholder() {
  return (
    <div className="w-full h-full flex items-center justify-center text-slate-300">
      <Package className="w-12 h-12" />
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone = (() => {
    switch (status) {
      case 'ACTIVE':
        return 'bg-emerald-100 text-emerald-800 border-emerald-200'
      case 'DRAFT':
        return 'bg-amber-100 text-amber-800 border-amber-200'
      case 'INACTIVE':
        return 'bg-slate-100 text-slate-600 border-slate-200'
      default:
        return 'bg-slate-100 text-slate-600 border-slate-200'
    }
  })()
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium',
        tone,
      )}
    >
      {status}
    </span>
  )
}

function StockIndicator({ stock }: { stock: number }) {
  const tone =
    stock === 0
      ? 'text-red-700'
      : stock <= 5
      ? 'text-amber-700'
      : 'text-emerald-700'
  const dot =
    stock === 0
      ? 'bg-red-500'
      : stock <= 5
      ? 'bg-amber-500'
      : 'bg-emerald-500'
  return (
    <span className={cn('text-[11px] inline-flex items-center gap-1', tone)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', dot)} />
      {stock === 0 ? 'Out' : `${stock} in stock`}
    </span>
  )
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-500',
  EBAY: 'bg-blue-600',
  SHOPIFY: 'bg-emerald-600',
  WOOCOMMERCE: 'bg-purple-600',
}

function ChannelDots({ channels }: { channels: string[] }) {
  if (!channels || channels.length === 0) {
    return (
      <span className="text-[10px] text-slate-400 italic">No channels</span>
    )
  }
  return (
    <div className="flex items-center gap-1">
      {channels.slice(0, 4).map((c) => (
        <span
          key={c}
          title={c}
          className={cn(
            'w-2.5 h-2.5 rounded-full',
            CHANNEL_TONE[c] ?? 'bg-slate-400',
          )}
        />
      ))}
      {channels.length > 4 && (
        <span className="text-[10px] text-slate-500 tabular-nums ml-0.5">
          +{channels.length - 4}
        </span>
      )}
    </div>
  )
}
