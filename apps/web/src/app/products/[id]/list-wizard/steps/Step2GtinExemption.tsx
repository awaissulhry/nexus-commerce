'use client'

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  ImageIcon,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

interface ImageItem {
  url: string
  ok: boolean
  width?: number
  height?: number
  format?: string
  bytes?: number
  issues: string[]
}

interface ImageValidation {
  passed: number
  failed: number
  needed: number
  items: ImageItem[]
}

interface Application {
  id: string
  brandName: string
  marketplace: string
  brandRegistrationType: string
  trademarkNumber: string | null
  trademarkCountry: string | null
  trademarkDate: string | null
  brandWebsite: string | null
  brandLetter: string
  brandLetterCustomised: boolean
  imagesProvided: string[]
  imageValidation: ImageValidation | null
  status: string
  amazonCaseId: string | null
  rejectionReason: string | null
  packageGeneratedAt: string | null
  submittedAt: string | null
  approvedAt: string | null
  rejectedAt: string | null
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PACKAGE_READY: 'Package ready',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ABANDONED: 'Abandoned',
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  PACKAGE_READY:
    'bg-blue-50 dark:bg-blue-950/40 text-blue-900 border-blue-200 dark:border-blue-900',
  SUBMITTED:
    'bg-amber-50 dark:bg-amber-950/40 text-amber-900 border-amber-200 dark:border-amber-900',
  APPROVED:
    'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 border-emerald-200 dark:border-emerald-900',
  REJECTED: 'bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-100 border-red-200 dark:border-red-900',
  ABANDONED:
    'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700',
}

interface Step1Slice {
  path?: 'have-code' | 'have-exemption' | 'apply-now'
}

export default function Step2GtinExemption({
  wizardState,
  updateWizardState,
  product,
  marketplace,
  embedded = false,
}: StepProps & { embedded?: boolean }) {
  const step1 = (wizardState.identifiers ?? {}) as Step1Slice
  const path = step1.path ?? 'apply-now'

  // ── Path 1 / 2 — Step 2 is informational only, just nudge Continue.
  if (path !== 'apply-now') {
    if (embedded) return null
    return <NotApplicable path={path} />
  }

  return (
    <ApplyFlow
      wizardState={wizardState}
      updateWizardState={updateWizardState}
      product={product}
      marketplace={marketplace}
      embedded={embedded}
    />
  )
}

function NotApplicable({ path }: { path: Step1Slice['path'] }) {
  return (
    <div className="max-w-2xl mx-auto py-12 px-6">
      <div className="text-center">
        <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
        <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          GTIN exemption not needed
        </h2>
        <p className="text-md text-slate-600 dark:text-slate-400 mt-2 max-w-md mx-auto">
          {path === 'have-code'
            ? "You provided a GTIN in Step 1, so we'll list this product under that identifier — no exemption required."
            : "Your brand already has an exemption on this marketplace, so we'll apply it automatically when this product is listed."}
        </p>
        <p className="text-base text-slate-500 dark:text-slate-400 mt-4">
          Click Continue to move on to product type selection.
        </p>
      </div>
    </div>
  )
}

function ApplyFlow({
  wizardState,
  updateWizardState,
  product,
  marketplace,
  embedded = false,
}: Pick<
  StepProps,
  'wizardState' | 'updateWizardState' | 'product' | 'marketplace'
> & { embedded?: boolean }) {
  const [app, setApp] = useState<Application | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [savingStatus, setSavingStatus] = useState(false)
  const [submitDialog, setSubmitDialog] = useState(false)
  const [rejectDialog, setRejectDialog] = useState(false)
  const [pasteCaseId, setPasteCaseId] = useState('')
  const [pasteRejection, setPasteRejection] = useState('')

  // ── Form fields. Mirror the application record but allow local
  //    editing before we persist.
  const [regType, setRegType] =
    useState<'TRADEMARK' | 'BRAND_STAND_IN' | 'WEBSITE_ONLY'>('TRADEMARK')
  const [trademarkNumber, setTrademarkNumber] = useState('')
  const [trademarkCountry, setTrademarkCountry] = useState('')
  const [trademarkDate, setTrademarkDate] = useState('')
  const [brandWebsite, setBrandWebsite] = useState('')

  const exemptionStateId =
    (wizardState.exemption as { applicationId?: string } | undefined)
      ?.applicationId ?? null

  // Load the application on mount: either the wizardState already
  // points at one, or we create one for (brand, marketplace, [productId]).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        if (!product.brand) {
          setError(
            'This product has no brand set. Add a brand on the product edit page before applying for an exemption.',
          )
          setLoading(false)
          return
        }
        let result: Application | null = null
        if (exemptionStateId) {
          const res = await fetch(
            `${getBackendUrl()}/api/gtin-exemption/${exemptionStateId}`,
            { cache: 'no-store' },
          )
          if (res.ok) {
            const json = await res.json()
            result = json.application as Application
          }
        }
        if (!result) {
          const res = await fetch(
            `${getBackendUrl()}/api/gtin-exemption`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                brandName: product.brand,
                marketplace,
                productIds: [product.id],
                brandRegistrationType: 'TRADEMARK',
              }),
            },
          )
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            throw new Error(j.error ?? `HTTP ${res.status}`)
          }
          const json = await res.json()
          result = json.application as Application
          if (result?.id !== exemptionStateId) {
            await updateWizardState({
              exemption: {
                applicationId: result?.id,
                status: result?.status,
              },
            })
          }
        }
        if (cancelled || !result) return
        setApp(result)
        setRegType(result.brandRegistrationType as any)
        setTrademarkNumber(result.trademarkNumber ?? '')
        setTrademarkCountry(result.trademarkCountry ?? '')
        setTrademarkDate(
          result.trademarkDate ? result.trademarkDate.slice(0, 10) : '',
        )
        setBrandWebsite(result.brandWebsite ?? '')
      } catch (err: any) {
        if (cancelled) return
        setError(err?.message ?? String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const patchApp = async (data: Partial<Application>): Promise<boolean> => {
    if (!app) return false
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/gtin-exemption/${app.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error ?? `HTTP ${res.status}`)
        return false
      }
      const json = await res.json()
      setApp(json.application as Application)
      return true
    } catch (err: any) {
      setError(err?.message ?? String(err))
      return false
    }
  }

  const saveBrandInfo = async () => {
    return patchApp({
      brandRegistrationType: regType,
      trademarkNumber: trademarkNumber || null,
      trademarkCountry: trademarkCountry || null,
      trademarkDate: trademarkDate || null,
      brandWebsite: brandWebsite || null,
    })
  }

  const runValidation = async () => {
    if (!app) return
    setValidating(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/gtin-exemption/${app.id}/validate-images`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error ?? `HTTP ${res.status}`)
      } else {
        const json = await res.json()
        setApp(json.application as Application)
      }
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setValidating(false)
    }
  }

  const downloadUrl = (which: 'pdf' | 'zip') =>
    app
      ? `${getBackendUrl()}/api/gtin-exemption/${app.id}/${
          which === 'pdf' ? 'brand-letter.pdf' : 'package.zip'
        }`
      : '#'

  const transitionStatus = async (next: string, extras: Partial<Application> = {}) => {
    setSavingStatus(true)
    const ok = await patchApp({ status: next, ...extras })
    setSavingStatus(false)
    if (ok) {
      await updateWizardState({
        exemption: {
          applicationId: app?.id,
          status: next,
        },
      })
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6 flex items-center justify-center text-slate-500 dark:text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading application…
      </div>
    )
  }
  if (error && !app) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6">
        <div className="px-4 py-3 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-md text-red-900 dark:text-red-100 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      </div>
    )
  }
  if (!app) return null

  const status = app.status
  const isTerminal = status === 'APPROVED' || status === 'REJECTED'

  return (
    <div
      className={cn(
        embedded ? 'space-y-4' : 'max-w-3xl mx-auto py-8 px-6 space-y-6',
      )}
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          {embedded ? (
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              GTIN Exemption — {app.brandName} on Amazon {marketplace}
            </h3>
          ) : (
            <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              GTIN Exemption — {app.brandName} on Amazon {marketplace}
            </h2>
          )}
          <p className="text-md text-slate-600 dark:text-slate-400 mt-1 max-w-2xl">
            We generate the submission package; you upload it to Seller
            Central. Once Amazon approves, every future {app.brandName}{' '}
            listing on Amazon {marketplace} skips this step.
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded border text-sm font-medium tabular-nums',
            STATUS_TONE[status] ?? STATUS_TONE.DRAFT,
          )}
        >
          {STATUS_LABEL[status] ?? status}
        </span>
      </header>

      {error && (
        <div className="px-4 py-2 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-base text-red-900 dark:text-red-100 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {/* ── Section 1 — Brand information ─────────────────────────── */}
      <Section
        title="Brand verification"
        description="Trademark significantly increases approval rate. Brand stand-in or website-only paths are accepted but more often rejected on first try."
      >
        <fieldset className="space-y-2 mb-4" disabled={isTerminal}>
          {[
            { v: 'TRADEMARK', label: 'I have a registered trademark' },
            {
              v: 'BRAND_STAND_IN',
              label: 'My brand is in Brand Stand-In phase',
            },
            {
              v: 'WEBSITE_ONLY',
              label: 'I have a brand website but no trademark yet',
            },
          ].map((opt) => (
            <label
              key={opt.v}
              className="flex items-center gap-2 text-md text-slate-700 dark:text-slate-300"
            >
              <input
                type="radio"
                checked={regType === opt.v}
                onChange={() => setRegType(opt.v as any)}
                className="w-3.5 h-3.5"
              />
              {opt.label}
            </label>
          ))}
        </fieldset>

        {regType === 'TRADEMARK' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Trademark number"
              value={trademarkNumber}
              onChange={setTrademarkNumber}
              placeholder="e.g. EU 018937481"
              disabled={isTerminal}
            />
            <Input
              label="Country of registration"
              value={trademarkCountry}
              onChange={setTrademarkCountry}
              placeholder="e.g. EU, IT, US"
              disabled={isTerminal}
            />
            <Input
              label="Registration date"
              value={trademarkDate}
              onChange={setTrademarkDate}
              type="date"
              disabled={isTerminal}
            />
          </div>
        )}
        {(regType === 'BRAND_STAND_IN' || regType === 'WEBSITE_ONLY') && (
          <Input
            label="Brand website"
            value={brandWebsite}
            onChange={setBrandWebsite}
            placeholder="https://"
            disabled={isTerminal}
          />
        )}

        {!isTerminal && (
          <button
            type="button"
            onClick={saveBrandInfo}
            className="mt-3 text-base text-blue-700 dark:text-blue-300 hover:text-blue-900"
          >
            Save brand info
          </button>
        )}
      </Section>

      {/* ── Section 2 — Image validation ───────────────────────────── */}
      <Section
        title="Product images"
        description="Amazon requires at least 9 images: ≥1000×1000 px, JPG/PNG, brand visible. We use the images already on this product."
      >
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={runValidation}
            disabled={validating || isTerminal}
            className={cn(
              'inline-flex items-center gap-1.5 h-7 px-2.5 text-base rounded-md border transition-colors',
              validating
                ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                : 'border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 text-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/60',
            )}
          >
            {validating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Validating…
              </>
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5" /> Run image validation
              </>
            )}
          </button>
          {app.imageValidation && (
            <span className="text-base text-slate-600 dark:text-slate-400">
              {app.imageValidation.passed} pass · {app.imageValidation.failed}{' '}
              fail · {app.imagesProvided.length} of{' '}
              {app.imageValidation.needed} required
            </span>
          )}
        </div>
        {!app.imageValidation && (
          <p className="text-base text-slate-500 dark:text-slate-400">
            Run validation to check resolution, format, and size against
            Amazon's requirements.
          </p>
        )}
        {app.imageValidation && (
          <ul className="space-y-1">
            {app.imageValidation.items.slice(0, 12).map((item, idx) => (
              <li
                key={idx}
                className="flex items-start gap-2 text-base py-1"
              >
                {item.ok ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                    <ImageIcon className="w-3 h-3 text-slate-400 dark:text-slate-500" />
                    <span className="font-mono text-xs tabular-nums w-12">
                      img-{String(idx + 1).padStart(2, '0')}
                    </span>
                    {item.width && item.height && (
                      <span>
                        {item.width}×{item.height}
                      </span>
                    )}
                    {item.format && (
                      <span className="text-slate-400 dark:text-slate-500">·</span>
                    )}
                    {item.format && (
                      <span className="text-slate-500 dark:text-slate-400">{item.format}</span>
                    )}
                  </div>
                  {item.issues.length > 0 && (
                    <ul className="mt-0.5 text-sm text-amber-700 dark:text-amber-300 space-y-0.5">
                      {item.issues.map((iss, i) => (
                        <li key={i}>· {iss}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {app.imagesProvided.length < 9 && app.imageValidation && (
          <div className="mt-3 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-base text-amber-900">
            You currently have {app.imagesProvided.length} image
            {app.imagesProvided.length === 1 ? '' : 's'} on this product.
            Amazon needs 9 — add more via the product edit page, then come
            back and re-run validation.
          </div>
        )}
      </Section>

      {/* ── Section 3 — Brand letter ───────────────────────────────── */}
      <Section
        title="Brand letter"
        description="Pre-filled from your account settings + the trademark info above. Download the PDF to read it; the package below bundles it for you."
      >
        <div className="flex items-center gap-2">
          <a
            href={downloadUrl('pdf')}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-base rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <FileText className="w-3.5 h-3.5" />
            Preview brand-letter.pdf
          </a>
          {app.brandLetterCustomised && (
            <span className="text-sm text-slate-500 dark:text-slate-400 italic">
              Customised
            </span>
          )}
        </div>
      </Section>

      {/* ── Section 4 — Submission package ─────────────────────────── */}
      <Section
        title="Submission package"
        description="Download the ZIP, then submit it on Seller Central using the included instructions.md."
      >
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={downloadUrl('zip')}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-md font-medium',
              'bg-blue-600 dark:bg-blue-700 text-white hover:bg-blue-700 dark:hover:bg-blue-600',
            )}
          >
            <Download className="w-3.5 h-3.5" />
            Download submission package (.zip)
          </a>
          <a
            href={`https://sellercentral.amazon.${
              marketplace === 'UK'
                ? 'co.uk'
                : marketplace.toLowerCase()
            }/`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open Seller Central
          </a>
        </div>
        <ul className="mt-3 text-base text-slate-600 dark:text-slate-400 space-y-1">
          <li>1. Open Seller Central → Catalog → Add Products</li>
          <li>2. Choose "Don't have a product ID?" → Apply for GTIN exemption</li>
          <li>3. Upload the files from the ZIP, paste the brand info above</li>
          <li>4. Submit — Amazon shows a case ID</li>
          <li>5. Click "Mark as submitted" below and paste the case ID</li>
        </ul>
      </Section>

      {/* ── Section 5 — Status ─────────────────────────────────────── */}
      <Section title="Status" description="Update the status as Amazon responds.">
        <div className="flex items-center gap-2 flex-wrap">
          {status === 'PACKAGE_READY' || status === 'DRAFT' ? (
            <button
              type="button"
              onClick={() => setSubmitDialog(true)}
              disabled={savingStatus}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-md font-medium bg-amber-600 text-white hover:bg-amber-700"
            >
              Mark as submitted
            </button>
          ) : null}
          {status === 'SUBMITTED' && (
            <>
              <button
                type="button"
                onClick={() =>
                  transitionStatus('APPROVED').then(() => null)
                }
                disabled={savingStatus}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-md font-medium bg-emerald-600 dark:bg-emerald-700 text-white hover:bg-emerald-700"
              >
                Mark as approved
              </button>
              <button
                type="button"
                onClick={() => setRejectDialog(true)}
                disabled={savingStatus}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-md font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Mark as rejected
              </button>
            </>
          )}
          {status === 'APPROVED' && (
            <p className="text-md text-emerald-800">
              ✨ Approved on{' '}
              {app.approvedAt
                ? new Date(app.approvedAt).toLocaleDateString()
                : ''}{' '}
              — every future {app.brandName} listing on Amazon{' '}
              {marketplace} now skips this step automatically.
            </p>
          )}
          {status === 'REJECTED' && (
            <div className="text-md text-red-900 dark:text-red-100">
              <div>
                Rejected
                {app.rejectedAt
                  ? ` on ${new Date(app.rejectedAt).toLocaleDateString()}`
                  : ''}
                .
              </div>
              {app.rejectionReason && (
                <div className="mt-1 italic text-slate-600 dark:text-slate-400">
                  Amazon's reason: {app.rejectionReason}
                </div>
              )}
              <button
                type="button"
                onClick={() => transitionStatus('DRAFT')}
                className="mt-2 text-base text-blue-700 dark:text-blue-300 hover:text-blue-900"
              >
                Update package and try again
              </button>
            </div>
          )}
        </div>
      </Section>

      {/* ── Modals ────────────────────────────────────────────────── */}
      {submitDialog && (
        <SmallDialog
          title="Confirm submission"
          onClose={() => setSubmitDialog(false)}
          onConfirm={async () => {
            await transitionStatus('SUBMITTED', {
              amazonCaseId: pasteCaseId.trim() || null,
            } as any)
            setSubmitDialog(false)
          }}
          confirmLabel="Mark as submitted"
        >
          <p className="text-md text-slate-700 dark:text-slate-300 mb-3">
            Did you submit on Amazon Seller Central? Optionally paste the
            case ID Amazon showed you.
          </p>
          <Input
            label="Amazon case ID (optional)"
            value={pasteCaseId}
            onChange={setPasteCaseId}
            placeholder="e.g. 0123456789"
          />
        </SmallDialog>
      )}
      {rejectDialog && (
        <SmallDialog
          title="Mark as rejected"
          onClose={() => setRejectDialog(false)}
          onConfirm={async () => {
            await transitionStatus('REJECTED', {
              rejectionReason: pasteRejection.trim() || null,
            } as any)
            setRejectDialog(false)
          }}
          confirmLabel="Mark as rejected"
        >
          <p className="text-md text-slate-700 dark:text-slate-300 mb-3">
            Paste the rejection reason from Amazon's email — we'll include
            it in the next package iteration.
          </p>
          <textarea
            value={pasteRejection}
            onChange={(e) => setPasteRejection(e.target.value)}
            placeholder="Paste Amazon's rejection email text"
            className="w-full h-24 px-2 py-1 text-md border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </SmallDialog>
      )}
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 px-5 py-4">
      <div className="mb-3">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h3>
        {description && (
          <p className="text-base text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>
        )}
      </div>
      {children}
    </div>
  )
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
}) {
  return (
    <div>
      <label className="block text-sm text-slate-500 dark:text-slate-400 mb-0.5">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-500"
      />
    </div>
  )
}

// C.2 — Modal primitive replaces the prior hand-rolled `fixed inset-0`
// overlay (focus trap, body scroll lock, escape-to-close, restored
// focus on dismiss are now handled by the primitive). Callsites
// already pass `open` via conditional render, so we route that
// straight through. Keeping the wrapper because both call sites
// share the title + confirm-button shape.
function SmallDialog({
  title,
  onClose,
  onConfirm,
  confirmLabel,
  children,
}: {
  title: string
  onClose: () => void
  onConfirm: () => void
  confirmLabel: string
  children: React.ReactNode
}) {
  return (
    <Modal open onClose={onClose} title={title} size="md">
      {children}
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
