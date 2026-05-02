'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

type Path = 'have-code' | 'have-exemption' | 'apply-now'

interface Identifiers {
  path?: Path
  gtinValue?: string
  trademarkNumber?: string
  exemptionApplicationId?: string
}

interface CheckResponse {
  approved?: {
    id: string
    brandName: string
    approvedAt: string | null
  }
  pending?: {
    id: string
    brandName: string
    submittedAt: string | null
    status: string
  }
}

function detectGtin(product: StepProps['product']): string | null {
  return (
    product.gtin ||
    product.upc ||
    product.ean ||
    null
  )
}

function isValidGtin(raw: string): boolean {
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 14
}

export default function Step1Identifiers({
  wizardState,
  updateWizardState,
  product,
  marketplace,
}: StepProps) {
  const existingGtin = detectGtin(product)
  const stateSlice = (wizardState.identifiers ?? {}) as Identifiers

  // Default selection logic:
  //  - existing GTIN on the product → "have-code"
  //  - else (the cache check below may flip this to "have-exemption")
  //  - else "apply-now"
  const [path, setPath] = useState<Path>(
    stateSlice.path ?? (existingGtin ? 'have-code' : 'apply-now'),
  )
  const [gtinValue, setGtinValue] = useState(
    stateSlice.gtinValue ?? existingGtin ?? '',
  )
  const [trademarkNumber, setTrademarkNumber] = useState(
    stateSlice.trademarkNumber ?? '',
  )
  const [cache, setCache] = useState<CheckResponse | null>(null)
  const [cacheLoading, setCacheLoading] = useState(true)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Look up an existing approved or pending exemption for this brand
  // + marketplace combo. If approved, we suggest the user skip
  // straight past Step 2 — every Xavia jacket on Amazon IT shouldn't
  // re-apply once the brand is cleared.
  useEffect(() => {
    if (!product.brand) {
      setCacheLoading(false)
      return
    }
    let cancelled = false
    const url = new URL(
      `${getBackendUrl()}/api/gtin-exemption/check`,
    )
    url.searchParams.set('brand', product.brand)
    url.searchParams.set('marketplace', marketplace)
    fetch(url.toString(), { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: CheckResponse) => {
        if (cancelled) return
        setCache(data)
        // If we found an approved record AND the user hasn't already
        // overridden the choice, default to "have-exemption".
        if (data.approved && !stateSlice.path) {
          setPath('have-exemption')
        }
      })
      .catch((err) => {
        if (cancelled) return
        setCacheError(`Couldn't check brand exemption status (${err})`)
      })
      .finally(() => {
        if (!cancelled) setCacheLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.brand, marketplace])

  const gtinValid = useMemo(() => {
    if (!gtinValue) return false
    return isValidGtin(gtinValue)
  }, [gtinValue])

  const continueDisabled =
    (path === 'have-code' && !gtinValid) ||
    (path === 'have-exemption' && !cache?.approved && !trademarkNumber) ||
    saving

  const onContinue = async () => {
    setSaving(true)
    const slice: Identifiers = {
      path,
      gtinValue: path === 'have-code' ? gtinValue : undefined,
      trademarkNumber:
        path === 'have-exemption' ? trademarkNumber : undefined,
      exemptionApplicationId: cache?.approved?.id,
    }
    await updateWizardState({ identifiers: slice }, { advance: true })
    setSaving(false)
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">
          Product Identifiers
        </h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Amazon needs a UPC / EAN / GTIN — or proof that your brand is
          exempted. Pick the path that fits your situation.
        </p>
      </div>

      {/* Cache surfaces ABOVE the radios so the user notices it before
       *  picking a path. */}
      {cacheLoading && (
        <div className="mb-4 flex items-center gap-2 text-[12px] text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Checking brand exemption status…
        </div>
      )}
      {cache?.approved && (
        <div className="mb-4 px-4 py-3 rounded-md bg-emerald-50 border border-emerald-200 text-[12px] text-emerald-900 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-600" />
          <div>
            <div className="font-semibold">
              Brand "{product.brand}" already has an approved exemption on
              Amazon {marketplace}
            </div>
            <div>
              Approved
              {cache.approved.approvedAt
                ? ` on ${new Date(
                    cache.approved.approvedAt,
                  ).toLocaleDateString()}`
                : ''}{' '}
              · We pre-selected "Brand has GTIN exemption" below.
            </div>
          </div>
        </div>
      )}
      {cache?.pending && !cache.approved && (
        <div className="mb-4 px-4 py-3 rounded-md bg-amber-50 border border-amber-200 text-[12px] text-amber-900 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
          <div>
            <div className="font-semibold">
              An exemption application for "{product.brand}" on Amazon{' '}
              {marketplace} is currently {cache.pending.status.toLowerCase()}
            </div>
            <div>
              You can wait for that one or continue with this product
              under a different identifier.
            </div>
          </div>
        </div>
      )}
      {cacheError && (
        <div className="mb-4 px-4 py-3 rounded-md bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
          {cacheError}
        </div>
      )}

      <div className="space-y-3">
        <Option
          checked={path === 'have-code'}
          onChange={() => setPath('have-code')}
          label="I have a UPC / EAN / GTIN for this product"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={gtinValue}
                onChange={(e) => setGtinValue(e.target.value)}
                placeholder="e.g. 1234567890123"
                className="flex-1 h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              {gtinValue.trim().length > 0 && (
                <span
                  className={cn(
                    'text-[11px]',
                    gtinValid ? 'text-emerald-700' : 'text-amber-700',
                  )}
                >
                  {gtinValid ? '✓ valid' : 'must be 8–14 digits'}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              Accepts any GS1 identifier — UPC (12 digits), EAN-13, ITF-14.
            </p>
          </div>
        </Option>

        <Option
          checked={path === 'have-exemption'}
          onChange={() => setPath('have-exemption')}
          label="My brand already has GTIN exemption on Amazon"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[12px] text-slate-700">
              Brand:{' '}
              <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">
                {product.brand ?? '(no brand on product)'}
              </span>
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-0.5">
                Trademark number (optional, helps approval rate)
              </label>
              <input
                value={trademarkNumber}
                onChange={(e) => setTrademarkNumber(e.target.value)}
                placeholder="e.g. EU 018937481"
                className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            {!cache?.approved && (
              <p className="text-[11px] text-amber-700">
                Heads-up: we don't have a record of an approved exemption
                for this brand. Pick the next option to apply.
              </p>
            )}
          </div>
        </Option>

        <Option
          checked={path === 'apply-now'}
          onChange={() => setPath('apply-now')}
          label="I need to apply for a GTIN exemption"
        >
          <p className="text-[12px] text-slate-600">
            Continue to Step 2. We generate the brand letter PDF and a
            submission package you upload to Amazon Seller Central — most
            sellers spend 2–3 days on the prep; ours takes about 5
            minutes.
          </p>
        </Option>
      </div>

      <div className="mt-8 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onContinue}
          disabled={continueDisabled}
          className={cn(
            'h-8 px-4 rounded-md text-[13px] font-medium',
            continueDisabled
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          {path === 'apply-now' ? 'Continue to apply' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

function Option({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean
  onChange: () => void
  label: string
  children?: React.ReactNode
}) {
  return (
    <label
      className={cn(
        'block px-4 py-3 rounded-lg border cursor-pointer transition-colors',
        checked
          ? 'border-blue-400 bg-blue-50/50'
          : 'border-slate-200 bg-white hover:border-slate-300',
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          checked={checked}
          onChange={onChange}
          className="mt-0.5 w-3.5 h-3.5 text-blue-600 border-slate-300 focus:ring-blue-500"
        />
        <div className="flex-1">
          <div className="text-[13px] font-medium text-slate-900">
            {label}
          </div>
          {checked && children && <div className="mt-2">{children}</div>}
        </div>
      </div>
    </label>
  )
}
