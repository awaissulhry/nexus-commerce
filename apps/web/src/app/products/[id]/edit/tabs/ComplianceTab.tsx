'use client'

/**
 * W7.1 — Compliance tab on /products/[id]/edit.
 *
 * EU compliance surface for Italian motorcycle gear operator (Xavia):
 *   - PPE category under Directive 2016/425 (Cat I / II / III)
 *   - Hazmat flags for ADR/IATA dangerous goods (accessories: aerosols etc.)
 *   - Certificate management: CE, EN 13595, EN 22.05, REACH, RoHS, WEEE …
 *     with file URL, expiry tracking, and status badges (Valid/Expiring/Expired)
 *   - Channel compliance status: which channels need which certs
 *
 * All certificate actions persist immediately (no dirty tracking needed).
 * PPE + hazmat fields save via the shared PATCH /api/products/bulk
 * endpoint (reusing the master-editor pattern) and do report dirty.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Badge } from '@/components/ui/Badge'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────

interface ProductCertificate {
  id: string
  productId: string
  certType: string
  certNumber: string | null
  standard: string | null
  issuingBody: string | null
  issuedAt: string | null
  expiresAt: string | null
  fileUrl: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

interface ProductStub {
  id: string
  sku: string
  name: string
  ppeCategory: string | null
  hazmatClass: string | null
  hazmatUnNumber: string | null
  version: number
}

interface ComplianceTabProps {
  product: ProductStub
  discardSignal: number
  onDirtyChange: (count: number) => void
}

// ── Constants ──────────────────────────────────────────────────────────

const PPE_CATEGORIES = [
  {
    value: 'CAT_I',
    label: 'Cat I — Minimal risk',
    labelIt: 'Cat I — Rischio minimo',
    desc: 'Simple design, self-assessable. E.g. gloves vs. minor cuts.',
  },
  {
    value: 'CAT_II',
    label: 'Cat II — Intermediate risk',
    labelIt: 'Cat II — Rischio intermedio',
    desc: 'Requires EC type-examination by a Notified Body. E.g. motorcycle gloves, textile jackets.',
  },
  {
    value: 'CAT_III',
    label: 'Cat III — Mortal/irreversible risk',
    labelIt: 'Cat III — Rischio mortale o irreversibile',
    desc: 'Annual surveillance + full QA system. E.g. motorcycle helmets, armoured body protectors (EN 13595).',
  },
]

const CERT_TYPES: { value: string; label: string; labelIt: string }[] = [
  { value: 'CE', label: 'CE marking', labelIt: 'Marcatura CE' },
  { value: 'EN_13595', label: 'EN 13595 (body protection)', labelIt: 'EN 13595 (protezione corpo)' },
  { value: 'EN_22_05', label: 'EN 22.05 / 960-1 (helmet)', labelIt: 'EN 22.05 / 960-1 (casco)' },
  { value: 'REACH', label: 'REACH declaration', labelIt: 'Dichiarazione REACH' },
  { value: 'ROHS', label: 'RoHS certificate', labelIt: 'Certificato RoHS' },
  { value: 'WEEE', label: 'WEEE registration', labelIt: 'Registrazione RAEE' },
  { value: 'ATEX', label: 'ATEX (explosive atmospheres)', labelIt: 'ATEX (atmosfere esplosive)' },
  { value: 'OTHER', label: 'Other', labelIt: 'Altro' },
]

const DAYS_TO_EXPIRY_WARN = 90

// ── Helpers ────────────────────────────────────────────────────────────

function certStatus(expiresAt: string | null): 'valid' | 'expiring' | 'expired' | 'no-expiry' {
  if (!expiresAt) return 'no-expiry'
  const msLeft = new Date(expiresAt).getTime() - Date.now()
  if (msLeft < 0) return 'expired'
  if (msLeft < DAYS_TO_EXPIRY_WARN * 86_400_000) return 'expiring'
  return 'valid'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

function daysLeft(expiresAt: string | null): number | null {
  if (!expiresAt) return null
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000)
}

// ── Sub-components ─────────────────────────────────────────────────────

function CertStatusBadge({ expiresAt }: { expiresAt: string | null }) {
  const status = certStatus(expiresAt)
  if (status === 'no-expiry') return null
  if (status === 'expired')
    return (
      <Badge className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800 text-xs gap-1">
        <X className="w-3 h-3" /> Expired
      </Badge>
    )
  if (status === 'expiring') {
    const d = daysLeft(expiresAt)
    return (
      <Badge className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 text-xs gap-1">
        <Clock className="w-3 h-3" /> {d}d left
      </Badge>
    )
  }
  return (
    <Badge className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 text-xs gap-1">
      <CheckCircle2 className="w-3 h-3" /> Valid
    </Badge>
  )
}

// ── Add Certificate Form ───────────────────────────────────────────────

interface AddCertFormProps {
  productId: string
  onCreated: (cert: ProductCertificate) => void
  onCancel: () => void
}

function AddCertForm({ productId, onCreated, onCancel }: AddCertFormProps) {
  const [certType, setCertType] = useState('CE')
  const [certNumber, setCertNumber] = useState('')
  const [standard, setStandard] = useState('')
  const [issuingBody, setIssuingBody] = useState('')
  const [issuedAt, setIssuedAt] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [fileUrl, setFileUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/products/${productId}/certificates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          certType,
          certNumber: certNumber || undefined,
          standard: standard || undefined,
          issuingBody: issuingBody || undefined,
          issuedAt: issuedAt || undefined,
          expiresAt: expiresAt || undefined,
          fileUrl: fileUrl || undefined,
          notes: notes || undefined,
        }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const cert: ProductCertificate = await res.json()
      onCreated(cert)
    } catch {
      setError('Failed to add certificate')
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400'

  return (
    <form onSubmit={handleSubmit} className="border border-slate-200 dark:border-slate-700 rounded-lg p-4 space-y-3 bg-slate-50 dark:bg-slate-800/40">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Certificate type *
          </label>
          <select value={certType} onChange={(e) => setCertType(e.target.value)} className={inputCls} required>
            {CERT_TYPES.map((ct) => (
              <option key={ct.value} value={ct.value}>{ct.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Certificate number
          </label>
          <input value={certNumber} onChange={(e) => setCertNumber(e.target.value)} placeholder="e.g. TÜV-12345" className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Standard
          </label>
          <input value={standard} onChange={(e) => setStandard(e.target.value)} placeholder="e.g. EN 13595-1:2002" className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Issuing body
          </label>
          <input value={issuingBody} onChange={(e) => setIssuingBody(e.target.value)} placeholder="e.g. TÜV Rheinland" className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Issued date
          </label>
          <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Expiry date
          </label>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={inputCls} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Certificate file URL
          </label>
          <input value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} placeholder="https://…/cert.pdf" className={inputCls} />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
            Notes
          </label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
          Add certificate
        </Button>
      </div>
    </form>
  )
}

// ── Main Tab ───────────────────────────────────────────────────────────

export default function ComplianceTab({ product, discardSignal, onDirtyChange }: ComplianceTabProps) {
  const { t, locale } = useTranslations()

  // ── Certificates state ──────────────────────────────────────────────
  const [certs, setCerts] = useState<ProductCertificate[]>([])
  const [certsLoading, setCertsLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedCerts, setExpandedCerts] = useState<Set<string>>(new Set())

  // ── PPE + Hazmat field state ────────────────────────────────────────
  const [ppeCategory, setPpeCategory] = useState<string>(product.ppeCategory ?? '')
  const [hazmatEnabled, setHazmatEnabled] = useState(
    !!(product.hazmatClass || product.hazmatUnNumber),
  )
  const [hazmatClass, setHazmatClass] = useState(product.hazmatClass ?? '')
  const [hazmatUnNumber, setHazmatUnNumber] = useState(product.hazmatUnNumber ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Dirty tracking — count the number of changed fields
  const dirtyRef = useRef(0)
  const origPpe = useRef(product.ppeCategory ?? '')
  const origHazmatClass = useRef(product.hazmatClass ?? '')
  const origHazmatUn = useRef(product.hazmatUnNumber ?? '')

  const reportDirty = useCallback(() => {
    let count = 0
    if (ppeCategory !== origPpe.current) count++
    if (hazmatClass !== origHazmatClass.current) count++
    if (hazmatUnNumber !== origHazmatUn.current) count++
    dirtyRef.current = count
    onDirtyChange(count)
  }, [ppeCategory, hazmatClass, hazmatUnNumber, onDirtyChange])

  useEffect(() => { reportDirty() }, [reportDirty])

  // Discard signal — reset to server state
  useEffect(() => {
    if (discardSignal === 0) return
    setPpeCategory(product.ppeCategory ?? '')
    setHazmatEnabled(!!(product.hazmatClass || product.hazmatUnNumber))
    setHazmatClass(product.hazmatClass ?? '')
    setHazmatUnNumber(product.hazmatUnNumber ?? '')
    dirtyRef.current = 0
    onDirtyChange(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardSignal])

  // ── Load certificates ───────────────────────────────────────────────
  const loadCerts = useCallback(async () => {
    setCertsLoading(true)
    try {
      const res = await fetch(`/api/products/${product.id}/certificates`)
      if (!res.ok) throw new Error()
      setCerts(await res.json())
    } finally {
      setCertsLoading(false)
    }
  }, [product.id])

  useEffect(() => { loadCerts() }, [loadCerts, discardSignal])

  // ── Save PPE + Hazmat ───────────────────────────────────────────────
  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const changes: Array<{ id: string; field: string; value: unknown }> = []
      if (ppeCategory !== origPpe.current)
        changes.push({ id: product.id, field: 'ppeCategory', value: ppeCategory || null })
      if (hazmatClass !== origHazmatClass.current)
        changes.push({ id: product.id, field: 'hazmatClass', value: hazmatClass || null })
      if (hazmatUnNumber !== origHazmatUn.current)
        changes.push({ id: product.id, field: 'hazmatUnNumber', value: hazmatUnNumber || null })

      if (changes.length === 0) { setSaving(false); return }

      const res = await fetch('/api/products/bulk', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': String(product.version),
        },
        body: JSON.stringify({ changes }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `${res.status}`)
      }
      origPpe.current = ppeCategory
      origHazmatClass.current = hazmatClass
      origHazmatUn.current = hazmatUnNumber
      dirtyRef.current = 0
      onDirtyChange(0)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Certificate actions ─────────────────────────────────────────────
  function handleCertCreated(cert: ProductCertificate) {
    setCerts((prev) => [cert, ...prev])
    setShowAddForm(false)
  }

  async function handleDeleteCert(certId: string) {
    setDeletingId(certId)
    try {
      await fetch(`/api/products/${product.id}/certificates/${certId}`, { method: 'DELETE' })
      setCerts((prev) => prev.filter((c) => c.id !== certId))
    } finally {
      setDeletingId(null)
    }
  }

  function toggleExpand(certId: string) {
    setExpandedCerts((prev) => {
      const next = new Set(prev)
      if (next.has(certId)) next.delete(certId)
      else next.add(certId)
      return next
    })
  }

  // ── Compliance summary (channel requirements) ───────────────────────
  const certTypeSet = new Set(certs.map((c) => c.certType))
  const hasCE = certTypeSet.has('CE')
  const hasEN13595 = certTypeSet.has('EN_13595')
  const hasReach = certTypeSet.has('REACH')

  const channelReqs = [
    {
      channel: 'Amazon EU',
      requirements: ['CE'],
      met: hasCE,
      note: 'CE marking required for all PPE sold on EU Amazon.',
    },
    {
      channel: 'eBay IT/DE/FR/ES',
      requirements: ['CE'],
      met: hasCE,
      note: 'CE marking enforced per eBay EU PPE policy since 2022.',
    },
    {
      channel: 'Body protection (EN 13595)',
      requirements: ['CE', 'EN_13595'],
      met: hasCE && hasEN13595,
      note: 'Jackets / trousers / gloves with impact protection need EN 13595.',
    },
    {
      channel: 'REACH substances',
      requirements: ['REACH'],
      met: hasReach,
      note: 'Required for products containing substances of concern (SVHC).',
    },
  ]

  const isDirty = dirtyRef.current > 0

  return (
    <div className="space-y-6">
      {/* ── PPE Classification ───────────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.compliance.ppeTitle')}
          </h2>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
            Directive 2016/425/EU
          </span>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('products.edit.compliance.ppeHint')}
          </p>
          <div className="grid gap-2">
            {PPE_CATEGORIES.map((cat) => (
              <label
                key={cat.value}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                  ppeCategory === cat.value
                    ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                )}
              >
                <input
                  type="radio"
                  name="ppeCategory"
                  value={cat.value}
                  checked={ppeCategory === cat.value}
                  onChange={() => setPpeCategory(cat.value)}
                  className="mt-0.5 accent-blue-500"
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {locale === 'it' ? cat.labelIt : cat.label}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{cat.desc}</div>
                </div>
              </label>
            ))}
            <label
              className={cn(
                'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                ppeCategory === ''
                  ? 'border-slate-400 dark:border-slate-500 bg-slate-50 dark:bg-slate-800/40'
                  : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
              )}
            >
              <input
                type="radio"
                name="ppeCategory"
                value=""
                checked={ppeCategory === ''}
                onChange={() => setPpeCategory('')}
                className="mt-0.5 accent-blue-500"
              />
              <div>
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {t('products.edit.compliance.ppeNone')}
                </div>
              </div>
            </label>
          </div>
        </div>
      </div>

      {/* ── Hazmat ──────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.compliance.hazmatTitle')}
          </h2>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">ADR / IATA DGR</span>
        </div>
        <div className="px-5 py-4 space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={hazmatEnabled}
              onChange={(e) => {
                setHazmatEnabled(e.target.checked)
                if (!e.target.checked) {
                  setHazmatClass('')
                  setHazmatUnNumber('')
                }
              }}
              className="accent-amber-500"
            />
            <span className="text-sm text-slate-800 dark:text-slate-200">
              {t('products.edit.compliance.hazmatFlag')}
            </span>
          </label>
          {hazmatEnabled && (
            <div className="grid grid-cols-2 gap-3 pl-6">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  {t('products.edit.compliance.hazmatClass')}
                </label>
                <input
                  value={hazmatClass}
                  onChange={(e) => setHazmatClass(e.target.value)}
                  placeholder="e.g. 3, 8, 9"
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  {t('products.edit.compliance.hazmatUnNumber')}
                </label>
                <input
                  value={hazmatUnNumber}
                  onChange={(e) => setHazmatUnNumber(e.target.value)}
                  placeholder="e.g. UN1950"
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Save bar (PPE + Hazmat) ───────────────────────────────────── */}
      {isDirty && (
        <div className="flex items-center gap-3 justify-end">
          {saveError && <span className="text-xs text-red-600 dark:text-red-400">{saveError}</span>}
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {t('products.edit.compliance.save')}
          </Button>
        </div>
      )}

      {/* ── Certificates ─────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <Award className="w-4 h-4 text-purple-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.compliance.certsTitle')}
          </h2>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400 mr-2">
            {certs.length} {certs.length === 1 ? 'certificate' : 'certificates'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowAddForm((v) => !v)}
            className="gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('products.edit.compliance.addCert')}
          </Button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {showAddForm && (
            <AddCertForm
              productId={product.id}
              onCreated={handleCertCreated}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {certsLoading ? (
            <div className="flex items-center justify-center py-8 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading certificates…
            </div>
          ) : certs.length === 0 && !showAddForm ? (
            <div className="py-8 text-center">
              <FileText className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('products.edit.compliance.noCerts')}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {certs.map((cert) => {
                const expanded = expandedCerts.has(cert.id)
                const typeLabel = CERT_TYPES.find((ct) => ct.value === cert.certType)?.label ?? cert.certType
                return (
                  <div key={cert.id} className="py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleExpand(cert.id)}
                        className="flex items-center gap-2 flex-1 text-left min-w-0"
                        aria-expanded={expanded}
                      >
                        {expanded
                          ? <ChevronUp className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                          : <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
                        <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {typeLabel}
                          {cert.certNumber && (
                            <span className="text-slate-500 dark:text-slate-400 font-normal ml-1.5 text-xs">
                              #{cert.certNumber}
                            </span>
                          )}
                        </span>
                        <CertStatusBadge expiresAt={cert.expiresAt} />
                        {cert.expiresAt && (
                          <span className="text-xs text-slate-400 dark:text-slate-500 flex-shrink-0">
                            exp {formatDate(cert.expiresAt)}
                          </span>
                        )}
                      </button>
                      {cert.fileUrl && (
                        <a
                          href={cert.fileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1 text-slate-400 hover:text-blue-500"
                          title="Open certificate file"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <IconButton
                        onClick={() => handleDeleteCert(cert.id)}
                        disabled={deletingId === cert.id}
                        size="sm"
                        aria-label="Delete certificate"
                        className="text-slate-400 hover:text-red-500"
                      >
                        {deletingId === cert.id
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />}
                      </IconButton>
                    </div>

                    {expanded && (
                      <div className="mt-2 pl-6 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                        {cert.standard && (
                          <>
                            <span className="text-slate-500 dark:text-slate-400">Standard</span>
                            <span className="text-slate-800 dark:text-slate-200">{cert.standard}</span>
                          </>
                        )}
                        {cert.issuingBody && (
                          <>
                            <span className="text-slate-500 dark:text-slate-400">Issuing body</span>
                            <span className="text-slate-800 dark:text-slate-200">{cert.issuingBody}</span>
                          </>
                        )}
                        {cert.issuedAt && (
                          <>
                            <span className="text-slate-500 dark:text-slate-400">Issued</span>
                            <span className="text-slate-800 dark:text-slate-200">{formatDate(cert.issuedAt)}</span>
                          </>
                        )}
                        {cert.expiresAt && (
                          <>
                            <span className="text-slate-500 dark:text-slate-400">Expires</span>
                            <span className="text-slate-800 dark:text-slate-200">{formatDate(cert.expiresAt)}</span>
                          </>
                        )}
                        {cert.notes && (
                          <>
                            <span className="text-slate-500 dark:text-slate-400">Notes</span>
                            <span className="text-slate-800 dark:text-slate-200">{cert.notes}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Channel compliance status ─────────────────────────────────── */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.compliance.channelStatusTitle')}
          </h2>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {channelReqs.map((req) => (
            <div key={req.channel} className="px-5 py-3 flex items-start gap-3">
              <div className="mt-0.5">
                {req.met ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{req.channel}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{req.note}</div>
              </div>
              <div className="flex gap-1 flex-wrap justify-end">
                {req.requirements.map((r) => (
                  <Badge
                    key={r}
                    className={cn(
                      'text-xs',
                      certTypeSet.has(r)
                        ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                        : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
                    )}
                  >
                    {r.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
