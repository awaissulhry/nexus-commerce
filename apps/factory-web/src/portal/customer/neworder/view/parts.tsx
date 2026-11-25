'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Lock } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useOrderingWords } from '../words'
// F-CP-154: the ONE "Your price" cell.
import { Input } from '@nexus/ui/primitives'
import '../neworder.css'

/**
 * Small parts New order & reorder and the Catalogue share (B-W2b-194): the "not part of your access" panel (design
 * noPermission: their own admin to ask, and Home), a failed read in our words with Try again (never drawn as an empty
 * list), a skeleton in the shape of the content with "Still loading…" after about a second, and the quiet line for a role
 * without prices.
 */

export function NotInAccess({ admins, homeHref }: { admins: readonly string[]; homeHref: string }) {
  const { t } = useOrderingWords()
  return (
    <div className="fw-pno">
      <EmptyState
        icon={<Lock size={24} aria-hidden />}
        title={t('noAccess.title')}
        description={admins.length > 0 ? t('noAccess.ask', { names: admins.join(', ') }) : t('noAccess.askAdmin')}
        action={
          <Button asChild>
            <a href={homeHref}>{t('noAccess.home')}</a>
          </Button>
        }
      />
    </div>
  )
}

export function ReadFailed({ title, onRetry }: { title: string; onRetry?: () => void }) {
  const { t } = useOrderingWords()
  return (
    <div className="fw-pno-failed" role="alert">
      <AlertCircle size={18} aria-hidden />
      <span>{title}</span>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          {t('state.retry')}
        </Button>
      ) : null}
    </div>
  )
}

/** A skeleton in the shape of the content (cards or rows); after about a second it says it is still loading. */
export function Loading({ rows = 3, height = 64, label, cards = false }: { rows?: number; height?: number; label?: string; cards?: boolean }) {
  const { t } = useOrderingWords()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className={cards ? 'fw-pno-loading fw-pno-loading-cards' : 'fw-pno-loading'} role="status" aria-busy="true" aria-label={label ?? t('state.loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={height} />
      ))}
      {slow ? <p className="fw-pno-hint">{t('state.stillLoading')}</p> : null}
    </div>
  )
}

export function PricesNote() {
  const { t } = useOrderingWords()
  return <p className="fw-pno-quiet">{t('prices.none')}</p>
}

// ---- F-CP-154 (customer page plan C5; 12 §2 part 6; review E4; 11 §1.3 D3): the ONE "Your price" cell (od-w1.1: a line's kind tag
// moved with the draft's lines to src/lib/order-draft/view/parts.tsx) ----
/**
 * The ONE "Your price (without VAT)" cell of a line (review E4: one owner, this step), for a price holder only — the customer's
 * Buyer, Finance or Admin: typed while the draft may be written ("18,50" or "18.50"; saved on leaving the cell, with the draft's
 * version), read otherwise. Anyone without the price grain never gets this cell: their part 6 says "Prices are not part of your
 * access." (the API sends no price to them and refuses one from them, M-CP-2).
 */
export function YourPriceCell({
  seq,
  access,
  saved,
  typed,
  problem,
  currency,
  onType,
  onLeave,
}: {
  seq: number
  access: 'edit' | 'read'
  /** The price the line holds (null: none yet). */
  saved: string | null
  /** What is typed and not saved yet (undefined: nothing). */
  typed: string | undefined
  /** Why the typed text cannot be saved (a key), or null. */
  problem: string | null
  currency: string
  onType?: (text: string) => void
  onLeave?: () => void
}) {
  const words = useOrderingWords()
  const { t } = words
  if (access === 'read') return <span className="fw-pno-ownprice">{words.price(saved, currency) ?? '—'}</span>
  const label = t('draftPage.price.cell', { seq })
  return (
    <span className="fw-pno-ownprice">
      <Input
        value={typed ?? (saved === null ? '' : words.locale === 'it' ? saved.replace('.', ',') : saved)}
        inputMode="decimal"
        autoComplete="off"
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        prefix={currency === 'EUR' ? '€' : currency}
        onChange={(event) => onType?.(event.target.value)}
        onBlur={() => onLeave?.()}
      />
      {problem ? <span className="fw-pno-ownprice-problem" role="alert">{t(problem)}</span> : null}
    </span>
  )
}
// ---- end F-CP-154
