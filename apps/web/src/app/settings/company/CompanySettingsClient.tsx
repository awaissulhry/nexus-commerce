'use client'

/**
 * Settings rebuild — Phase D.4
 *
 * /settings/company — Company & fiscal. Sections:
 *
 *   • Identity   — company name, contact email/phone, website
 *   • Address    — multi-line, free-form (legal seat)
 *   • Logo       — Cloudinary upload (existing endpoint reused)
 *   • Fiscal     — P.IVA, Codice Fiscale, SDI, PEC, VAT scheme.
 *                  Inline checksum validation (client) + strict
 *                  reject from the server (matched algorithm).
 *   • Documents  — signature block, default PO notes, factory
 *                  email-from, requireApprovalForPo toggle.
 *
 * SaveBar wired via useSettingsForm — Save / Discard / Cmd+S /
 * dirty-state guard come from the shell.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertCircle,
  Building2,
  Check,
  Image as ImageIcon,
  Loader2,
  Receipt,
  Upload,
  FileText,
  Trash2,
  Globe,
  Info,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { useSettingsForm } from '../_shell/SettingsSaveBar'
import { Listbox } from '@/design-system/components/Listbox'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import {
  VAT_SCHEMES,
  validatePiva,
  validateCodiceFiscale,
  validateSdi,
  validatePec,
  validateInvoicingRouting,
} from '@/lib/italian-fiscal'

interface BrandSettings {
  id?: string
  companyName: string | null
  addressLines: string[]
  taxId: string | null
  contactEmail: string | null
  contactPhone: string | null
  websiteUrl: string | null
  logoUrl: string | null
  signatureBlockText: string | null
  defaultPoNotes: string | null
  factoryEmailFrom: string | null
  // Phase D additions
  piva: string | null
  codiceFiscale: string | null
  sdiCode: string | null
  pecEmail: string | null
  vatScheme: string | null
  // PO.7 — purchase-order approval ladder.
  requireApprovalForPo: boolean
  poApprovalThresholdCents: number | null
  poApprovalApproverEmail: string | null
}

const EMPTY: BrandSettings = {
  companyName: null,
  addressLines: [],
  taxId: null,
  contactEmail: null,
  contactPhone: null,
  websiteUrl: null,
  logoUrl: null,
  signatureBlockText: null,
  defaultPoNotes: null,
  factoryEmailFrom: null,
  piva: null,
  codiceFiscale: null,
  sdiCode: null,
  pecEmail: null,
  vatScheme: null,
  requireApprovalForPo: false,
  poApprovalThresholdCents: null,
  poApprovalApproverEmail: null,
}

// Fields that contribute to dirty-state. Sorted by section so the
// Save bar's diff reflects how the user thinks about the form.
const DIRTY_KEYS: Array<keyof BrandSettings> = [
  'companyName',
  'addressLines',
  'taxId',
  'contactEmail',
  'contactPhone',
  'websiteUrl',
  'logoUrl',
  'signatureBlockText',
  'defaultPoNotes',
  'factoryEmailFrom',
  'piva',
  'codiceFiscale',
  'sdiCode',
  'pecEmail',
  'vatScheme',
  'requireApprovalForPo',
  'poApprovalThresholdCents',
  'poApprovalApproverEmail',
]

function equalish(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => v === b[i])
  }
  return false
}

export default function CompanySettingsClient() {
  const [loaded, setLoaded] = useState<BrandSettings | null>(null)
  const [draft, setDraft] = useState<BrandSettings>(EMPTY)
  const [addressDraft, setAddressDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [serverFieldErrors, setServerFieldErrors] = useState<
    Record<string, string>
  >({})
  const [uploading, setUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null!)

  // ── Load ─────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/settings/brand`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as Partial<BrandSettings>
      const next: BrandSettings = {
        ...EMPTY,
        ...json,
        addressLines: Array.isArray(json.addressLines) ? json.addressLines : [],
      }
      setLoaded(next)
      setDraft(next)
      setAddressDraft(next.addressLines.join('\n'))
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // ── Dirty detection ──────────────────────────────────────────
  const draftWithAddress = useMemo(() => {
    const lines = addressDraft
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    return { ...draft, addressLines: lines }
  }, [draft, addressDraft])

  const isDirty = useMemo(() => {
    if (!loaded) return false
    for (const k of DIRTY_KEYS) {
      if (!equalish((draftWithAddress as any)[k], (loaded as any)[k])) return true
    }
    return false
  }, [draftWithAddress, loaded])

  // ── Client-side fiscal validation (instant) ──────────────────
  const fiscalErrors = useMemo(() => {
    const out: Record<string, string> = {}
    const piva = draft.piva ?? ''
    const cf = draft.codiceFiscale ?? ''
    const sdi = draft.sdiCode ?? ''
    const pec = draft.pecEmail ?? ''
    const v1 = validatePiva(piva)
    if (!v1.valid) out.piva = v1.reason
    const v2 = validateCodiceFiscale(cf)
    if (!v2.valid) out.codiceFiscale = v2.reason
    const v3 = validateSdi(sdi)
    if (!v3.valid) out.sdiCode = v3.reason
    const v4 = validatePec(pec)
    if (!v4.valid) out.pecEmail = v4.reason
    if (piva.trim()) {
      const r = validateInvoicingRouting({ piva, sdiCode: sdi, pecEmail: pec })
      if (!r.valid) out.routing = r.reason
    }
    return out
  }, [draft.piva, draft.codiceFiscale, draft.sdiCode, draft.pecEmail])

  // Effective error per field — merge client-side check with whatever
  // the server reported on the last save attempt. Server wins because
  // it's the authoritative source.
  const errs = useMemo(
    () => ({ ...fiscalErrors, ...serverFieldErrors }),
    [fiscalErrors, serverFieldErrors],
  )

  const hasFiscalErrors = Object.keys(errs).length > 0

  // ── Save / discard ───────────────────────────────────────────
  const onSave = useCallback(async () => {
    if (hasFiscalErrors) {
      // Surface the first error in the bar so the user knows why.
      const first = Object.values(errs)[0]
      throw new Error(first ?? 'Fix the highlighted fields before saving.')
    }
    setServerFieldErrors({})
    const res = await fetch(`${getBackendUrl()}/api/settings/brand`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draftWithAddress),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      if (body?.fieldErrors) {
        setServerFieldErrors(body.fieldErrors as Record<string, string>)
      }
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    const json = (await res.json()) as Partial<BrandSettings>
    const next: BrandSettings = {
      ...EMPTY,
      ...json,
      addressLines: Array.isArray(json.addressLines) ? json.addressLines : [],
    }
    setLoaded(next)
    setDraft(next)
    setAddressDraft(next.addressLines.join('\n'))
  }, [draftWithAddress, hasFiscalErrors, errs])

  const onDiscard = useCallback(() => {
    if (!loaded) return
    setDraft(loaded)
    setAddressDraft(loaded.addressLines.join('\n'))
    setServerFieldErrors({})
  }, [loaded])

  useSettingsForm({
    id: 'settings/company',
    isDirty,
    onSave,
    onDiscard,
  })

  // ── Logo upload ──────────────────────────────────────────────
  const uploadLogo = async (file: File) => {
    setUploading(true)
    setLogoError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${getBackendUrl()}/api/settings/brand/logo`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const b = await res.json().catch(() => null)
        throw new Error(b?.error ?? `Upload failed (${res.status})`)
      }
      const data = (await res.json()) as { logoUrl: string }
      // Server already persisted to BrandSettings; sync our local
      // copies so the SaveBar doesn't flag this as dirty.
      setDraft((d) => ({ ...d, logoUrl: data.logoUrl }))
      setLoaded((l) => (l ? { ...l, logoUrl: data.logoUrl } : l))
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500 dark:text-slate-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      {loadError && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      <IdentitySection draft={draft} setDraft={setDraft} />
      <AddressSection draft={addressDraft} setDraft={setAddressDraft} />
      <LogoSection
        logoUrl={draft.logoUrl}
        uploading={uploading}
        error={logoError}
        onUpload={uploadLogo}
        onUrlChange={(url) => setDraft((d) => ({ ...d, logoUrl: url || null }))}
        fileRef={fileRef}
      />
      <FiscalSection draft={draft} setDraft={setDraft} errors={errs} />
      <DocumentsSection draft={draft} setDraft={setDraft} />
      <PoApprovalSection draft={draft} setDraft={setDraft} />
    </div>
  )
}

// ─── shared shells ────────────────────────────────────────────────

function Card({
  title,
  description,
  icon,
  children,
}: {
  title: string
  description?: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-subtle dark:border-slate-800">
        {icon && (
          <div className="shrink-0 w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
            {icon}
          </div>
        )}
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          {description && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-rose-600 dark:text-rose-400 mt-1 inline-flex items-center gap-1">
          <AlertCircle size={11} /> {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{hint}</p>
      ) : null}
    </div>
  )
}

const INPUT_CLS =
  'w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

const INPUT_ERR_CLS =
  'border-rose-400 focus:border-rose-500 focus:ring-rose-400'

// ─── Identity ─────────────────────────────────────────────────────

function IdentitySection({
  draft,
  setDraft,
}: {
  draft: BrandSettings
  setDraft: React.Dispatch<React.SetStateAction<BrandSettings>>
}) {
  return (
    <Card
      title="Identity"
      description="Public-facing company information shown on POs, packing slips, and channel listings."
      icon={<Building2 size={14} />}
    >
      <div className="space-y-4">
        <Field label="Company name" htmlFor="companyName">
          <input
            id="companyName"
            value={draft.companyName ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, companyName: e.target.value || null }))
            }
            className={INPUT_CLS}
            placeholder="Xavia Racing S.r.l."
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Contact email" htmlFor="contactEmail">
            <input
              id="contactEmail"
              type="email"
              value={draft.contactEmail ?? ''}
              onChange={(e) =>
                setDraft((d) => ({ ...d, contactEmail: e.target.value || null }))
              }
              className={INPUT_CLS}
              placeholder="info@xaviaracing.it"
            />
          </Field>
          <Field label="Contact phone" htmlFor="contactPhone">
            <input
              id="contactPhone"
              type="tel"
              value={draft.contactPhone ?? ''}
              onChange={(e) =>
                setDraft((d) => ({ ...d, contactPhone: e.target.value || null }))
              }
              className={INPUT_CLS}
              placeholder="+39 06 1234567"
            />
          </Field>
        </div>
        <Field label="Website" htmlFor="websiteUrl">
          <input
            id="websiteUrl"
            type="url"
            value={draft.websiteUrl ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, websiteUrl: e.target.value || null }))
            }
            className={INPUT_CLS}
            placeholder="https://xaviaracing.it"
          />
        </Field>
      </div>
    </Card>
  )
}

// ─── Address ──────────────────────────────────────────────────────

function AddressSection({
  draft,
  setDraft,
}: {
  draft: string
  setDraft: React.Dispatch<React.SetStateAction<string>>
}) {
  return (
    <Card
      title="Address"
      description="Sede legale (legal seat). One line per row — appears on letterhead and POs."
      icon={<Globe size={14} />}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        className={cn(INPUT_CLS, 'font-mono')}
        placeholder={'Via Aurelia 123\n00165 Roma RM\nItalia'}
      />
    </Card>
  )
}

// ─── Logo ─────────────────────────────────────────────────────────

function LogoSection({
  logoUrl,
  uploading,
  error,
  onUpload,
  onUrlChange,
  fileRef,
}: {
  logoUrl: string | null
  uploading: boolean
  error: string | null
  onUpload: (file: File) => void
  onUrlChange: (url: string) => void
  fileRef: React.RefObject<HTMLInputElement>
}) {
  return (
    <Card
      title="Logo"
      description="600×200 transparent PNG works best. Or paste a hosted URL directly."
      icon={<ImageIcon size={14} />}
    >
      <div className="flex items-start gap-4">
        <div className="shrink-0 w-32 h-16 border border-default dark:border-slate-700 rounded bg-white flex items-center justify-center overflow-hidden">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt="Logo"
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <ImageIcon size={20} className="text-slate-300 dark:text-slate-600" />
          )}
        </div>
        <div className="flex-1 space-y-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onUpload(f)
              e.target.value = ''
            }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 h-8 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              {uploading ? 'Uploading…' : 'Upload logo'}
            </button>
            {logoUrl && (
              <button
                type="button"
                onClick={() => onUrlChange('')}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-sm text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40"
              >
                <Trash2 size={12} /> Remove
              </button>
            )}
          </div>
          <input
            type="url"
            value={logoUrl ?? ''}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://cdn.example.com/logo.png"
            className={cn(INPUT_CLS, 'text-xs')}
          />
          {error && (
            <p className="text-xs text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

// ─── Fiscal (Phase D heart) ───────────────────────────────────────

function FiscalSection({
  draft,
  setDraft,
  errors,
}: {
  draft: BrandSettings
  setDraft: React.Dispatch<React.SetStateAction<BrandSettings>>
  errors: Record<string, string>
}) {
  const validPiva = draft.piva && draft.piva.trim() && !errors.piva
  const validCf = draft.codiceFiscale && draft.codiceFiscale.trim() && !errors.codiceFiscale
  const validSdi = draft.sdiCode && draft.sdiCode.trim() && !errors.sdiCode
  const validPec = draft.pecEmail && draft.pecEmail.trim() && !errors.pecEmail
  return (
    <Card
      title="Italian fiscal"
      description="Required for B2B e-invoicing via Sistema di Interscambio. Validated on save — bad checksums reject."
      icon={<Receipt size={14} />}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="P.IVA"
            htmlFor="piva"
            hint="11 digits. Mod-11 checksum validated."
            error={errors.piva}
          >
            <div className="relative">
              <input
                id="piva"
                value={draft.piva ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, piva: e.target.value || null }))
                }
                className={cn(
                  INPUT_CLS,
                  errors.piva && INPUT_ERR_CLS,
                  validPiva && 'border-emerald-300 dark:border-emerald-800',
                  'font-mono tabular-nums',
                )}
                placeholder="01234567890"
                inputMode="numeric"
                maxLength={11}
              />
              {validPiva && (
                <Check
                  size={14}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400"
                />
              )}
            </div>
          </Field>
          <Field
            label="Codice Fiscale"
            htmlFor="codiceFiscale"
            hint="16 alphanumeric (natural person) or 11 digits (company)."
            error={errors.codiceFiscale}
          >
            <div className="relative">
              <input
                id="codiceFiscale"
                value={draft.codiceFiscale ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    codiceFiscale: e.target.value.toUpperCase() || null,
                  }))
                }
                className={cn(
                  INPUT_CLS,
                  errors.codiceFiscale && INPUT_ERR_CLS,
                  validCf && 'border-emerald-300 dark:border-emerald-800',
                  'font-mono uppercase',
                )}
                placeholder="RSSMRA80A01H501Z"
                maxLength={16}
              />
              {validCf && (
                <Check
                  size={14}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400"
                />
              )}
            </div>
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="SDI code"
            htmlFor="sdiCode"
            hint='7 alphanumeric. Use "0000000" to route via PEC instead.'
            error={errors.sdiCode}
          >
            <div className="relative">
              <input
                id="sdiCode"
                value={draft.sdiCode ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    sdiCode: e.target.value.toUpperCase() || null,
                  }))
                }
                className={cn(
                  INPUT_CLS,
                  errors.sdiCode && INPUT_ERR_CLS,
                  validSdi && 'border-emerald-300 dark:border-emerald-800',
                  'font-mono tabular-nums uppercase',
                )}
                placeholder="ABC1234"
                maxLength={7}
              />
              {validSdi && (
                <Check
                  size={14}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400"
                />
              )}
            </div>
          </Field>
          <Field
            label="PEC email"
            htmlFor="pecEmail"
            hint="Posta Elettronica Certificata. Alternative to SDI for invoice routing."
            error={errors.pecEmail}
          >
            <div className="relative">
              <input
                id="pecEmail"
                type="email"
                value={draft.pecEmail ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, pecEmail: e.target.value || null }))
                }
                className={cn(
                  INPUT_CLS,
                  errors.pecEmail && INPUT_ERR_CLS,
                  validPec && 'border-emerald-300 dark:border-emerald-800',
                )}
                placeholder="azienda@pec.it"
              />
              {validPec && (
                <Check
                  size={14}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-600 dark:text-emerald-400"
                />
              )}
            </div>
          </Field>
        </div>

        {errors.routing && (
          <div className="flex items-start gap-2 p-3 rounded-md border border-amber-300 bg-amber-50 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{errors.routing}</span>
          </div>
        )}

        <Field
          label="VAT scheme"
          hint="Drives invoice math + downstream rimanenze valuation."
          error={errors.vatScheme}
        >
          <Listbox
            value={draft.vatScheme ?? ''}
            onChange={(v) =>
              setDraft((d) => ({ ...d, vatScheme: v || null }))
            }
            options={[
              { value: '', label: '— Not set —' },
              ...VAT_SCHEMES.map((s) => ({
                value: s.value,
                label: `${s.label} — ${s.description}`,
              })),
            ]}
            ariaLabel="VAT scheme"
            className="w-full"
          />
        </Field>

        <div className="flex items-start gap-2 p-3 rounded-md border border-default dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 text-xs text-slate-600 dark:text-slate-400">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>
            Legacy free-text "Tax ID" field is preserved below for non-IT
            jurisdictions. Italian invoicing reads from P.IVA + SDI + PEC.
          </span>
        </div>

        <Field
          label="Legacy tax ID"
          htmlFor="taxId"
          hint="Free-form. Used for non-Italian tax IDs or as a notes field."
        >
          <input
            id="taxId"
            value={draft.taxId ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, taxId: e.target.value || null }))
            }
            className={INPUT_CLS}
          />
        </Field>
      </div>
    </Card>
  )
}

// ─── Documents ────────────────────────────────────────────────────

function DocumentsSection({
  draft,
  setDraft,
}: {
  draft: BrandSettings
  setDraft: React.Dispatch<React.SetStateAction<BrandSettings>>
}) {
  return (
    <Card
      title="Documents"
      description="Defaults baked into every factory PO + supplier email."
      icon={<FileText size={14} />}
    >
      <div className="space-y-4">
        <Field label="Signature block" htmlFor="signatureBlockText">
          <input
            id="signatureBlockText"
            value={draft.signatureBlockText ?? ''}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                signatureBlockText: e.target.value || null,
              }))
            }
            className={INPUT_CLS}
            placeholder="Per: Awais Sulhry / Procurement"
          />
        </Field>
        <Field
          label="Default PO notes"
          htmlFor="defaultPoNotes"
          hint="Appears on every factory PO body unless overridden."
        >
          <textarea
            id="defaultPoNotes"
            value={draft.defaultPoNotes ?? ''}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                defaultPoNotes: e.target.value || null,
              }))
            }
            rows={3}
            className={INPUT_CLS}
          />
        </Field>
        <Field
          label="Factory emails from"
          htmlFor="factoryEmailFrom"
          hint='Format: "Name <email@domain.com>". Surfaces in supplier emails.'
        >
          <input
            id="factoryEmailFrom"
            value={draft.factoryEmailFrom ?? ''}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                factoryEmailFrom: e.target.value || null,
              }))
            }
            className={INPUT_CLS}
            placeholder="Xavia Racing <po@xaviaracing.it>"
          />
        </Field>
      </div>
    </Card>
  )
}

// PO.7 — Purchase-order approval ladder.
//
// Three orthogonal controls:
//   1. requireApprovalForPo — legacy boolean. When true, every PO
//      stops at REVIEW until an approver clicks Approve, regardless
//      of value.
//   2. poApprovalThresholdCents — value ceiling. POs with totalCents
//      at-or-below auto-advance through REVIEW → APPROVED on
//      submit-for-review. POs above stop at REVIEW.
//   3. poApprovalApproverEmail — operator-known approver address.
//      Currently surfaces in the UI only; PO.9 will wire it into an
//      actual email notification.
function PoApprovalSection({
  draft,
  setDraft,
}: {
  draft: BrandSettings
  setDraft: React.Dispatch<React.SetStateAction<BrandSettings>>
}) {
  const thresholdEuros =
    draft.poApprovalThresholdCents == null
      ? ''
      : (draft.poApprovalThresholdCents / 100).toFixed(2)

  return (
    <Card
      title="Purchase order approval"
      description="Value-based ladder for /fulfillment/purchase-orders. POs above the threshold stop at REVIEW until approved."
      icon={<FileText size={14} />}
    >
      <div className="space-y-4">
        <Field
          label="Always require approval"
          htmlFor="requireApprovalForPo"
          hint="When on, every PO sits in REVIEW until an approver clicks Approve — threshold ignored."
        >
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              id="requireApprovalForPo"
              type="checkbox"
              checked={draft.requireApprovalForPo}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  requireApprovalForPo: e.target.checked,
                }))
              }
              className="w-4 h-4 accent-slate-900 dark:accent-slate-100"
            />
            <span className="text-base text-slate-700 dark:text-slate-300">
              {draft.requireApprovalForPo ? 'On' : 'Off'}
            </span>
          </label>
        </Field>

        <Field
          label="Auto-approve threshold (EUR)"
          htmlFor="poApprovalThresholdCents"
          hint="POs at-or-below this total auto-advance through REVIEW → APPROVED. POs above stop at REVIEW. Leave empty to disable the threshold (legacy boolean alone gates)."
        >
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary dark:text-slate-500 text-base pointer-events-none">
              €
            </span>
            <input
              id="poApprovalThresholdCents"
              type="number"
              min="0"
              step="0.01"
              value={thresholdEuros}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') {
                  setDraft((d) => ({ ...d, poApprovalThresholdCents: null }))
                  return
                }
                const n = parseFloat(raw)
                setDraft((d) => ({
                  ...d,
                  poApprovalThresholdCents: Number.isFinite(n)
                    ? Math.max(0, Math.round(n * 100))
                    : null,
                }))
              }}
              placeholder="5000.00"
              className={`${INPUT_CLS} pl-6`}
              disabled={draft.requireApprovalForPo}
            />
          </div>
        </Field>

        <Field
          label="Approver email"
          htmlFor="poApprovalApproverEmail"
          hint="Used by PO.9 to email the approver when a PO exceeds the threshold. Optional — until PO.9 ships, this is operator-known reference only."
        >
          <input
            id="poApprovalApproverEmail"
            type="email"
            value={draft.poApprovalApproverEmail ?? ''}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                poApprovalApproverEmail: e.target.value || null,
              }))
            }
            placeholder="cfo@xaviaracing.it"
            className={INPUT_CLS}
          />
        </Field>
      </div>
    </Card>
  )
}
