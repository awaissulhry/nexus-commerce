'use client'

// Constraint #1 — /settings/company. Loads BrandSettings via GET, edits
// every field, persists via PATCH. Logo upload routes through the
// Cloudinary endpoint with a manual-URL fallback.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Image as ImageIcon,
  Trash2,
  Upload,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { getBackendUrl } from '@/lib/backend-url'

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
}

export default function CompanySettingsClient() {
  const [settings, setSettings] = useState<BrandSettings>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [addressDraft, setAddressDraft] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/settings/brand`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setSettings({
        ...EMPTY,
        ...json,
        addressLines: Array.isArray(json.addressLines) ? json.addressLines : [],
      })
      setAddressDraft(
        Array.isArray(json.addressLines) ? json.addressLines.join('\n') : '',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const setField = <K extends keyof BrandSettings>(
    key: K,
    value: BrandSettings[K],
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // Convert the textarea-friendly addressDraft into the array shape
      // the API expects (one line per address line, empty rows dropped).
      const addressLines = addressDraft
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const payload: Partial<BrandSettings> = { ...settings, addressLines }
      const res = await fetch(`${getBackendUrl()}/api/settings/brand`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setSettings({
        ...EMPTY,
        ...json,
        addressLines: Array.isArray(json.addressLines) ? json.addressLines : [],
      })
      setAddressDraft(
        Array.isArray(json.addressLines) ? json.addressLines.join('\n') : '',
      )
      setSavedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const onPickLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${getBackendUrl()}/api/settings/brand/logo`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setField('logoUrl', json.logoUrl)
      setSavedAt(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      // Reset the file input so picking the same file again still triggers
      // the change event.
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeLogo = () => {
    setField('logoUrl', null)
  }

  if (loading) {
    return (
      <Card>
        <div className="text-md text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded px-3 py-2 text-base text-rose-700 inline-flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {savedAt && Date.now() - savedAt < 4000 && (
        <div className="border border-emerald-200 bg-emerald-50 rounded px-3 py-2 text-base text-emerald-700 inline-flex items-center gap-1.5">
          <CheckCircle2 size={14} /> Saved
        </div>
      )}

      {/* Logo */}
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="text-md font-semibold text-slate-900 mb-1">
              Letterhead logo
            </div>
            <div className="text-base text-slate-500 mb-3">
              Hosted on Cloudinary. ~600×200px transparent PNG works best at
              letter size.
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onPickLogoFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {uploading ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" /> Uploading…
                  </>
                ) : (
                  <>
                    <Upload size={12} /> Upload logo
                  </>
                )}
              </button>
              {settings.logoUrl && (
                <button
                  type="button"
                  onClick={removeLogo}
                  className="h-8 px-2 text-base border border-slate-200 text-slate-500 rounded hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 inline-flex items-center gap-1.5"
                >
                  <Trash2 size={12} /> Remove
                </button>
              )}
            </div>

            <div className="mt-3">
              <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
                Or paste a hosted URL
              </label>
              <Input
                value={settings.logoUrl ?? ''}
                onChange={(e) =>
                  setField('logoUrl', e.target.value.trim() || null)
                }
                placeholder="https://cdn.example.com/logo.png"
                className="mt-1"
              />
            </div>
          </div>
          <div className="w-40 h-24 border border-slate-200 rounded bg-slate-50 flex items-center justify-center overflow-hidden flex-shrink-0">
            {settings.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={settings.logoUrl}
                alt="Letterhead logo preview"
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <div className="text-slate-400 inline-flex flex-col items-center gap-1">
                <ImageIcon size={20} />
                <span className="text-xs">no logo</span>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Identity */}
      <Card>
        <div className="text-md font-semibold text-slate-900 mb-3">
          Company identity
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Company name">
            <Input
              value={settings.companyName ?? ''}
              onChange={(e) =>
                setField('companyName', e.target.value || null)
              }
              placeholder="Xavia Racing s.r.l."
            />
          </Field>
          <Field label="Tax ID / VAT">
            <Input
              value={settings.taxId ?? ''}
              onChange={(e) => setField('taxId', e.target.value || null)}
              placeholder="IT12345678901"
            />
          </Field>
          <Field label="Contact email">
            <Input
              type="email"
              value={settings.contactEmail ?? ''}
              onChange={(e) =>
                setField('contactEmail', e.target.value || null)
              }
              placeholder="orders@xavia.it"
            />
          </Field>
          <Field label="Contact phone">
            <Input
              value={settings.contactPhone ?? ''}
              onChange={(e) =>
                setField('contactPhone', e.target.value || null)
              }
              placeholder="+39 06 12345678"
            />
          </Field>
          <Field label="Website">
            <Input
              value={settings.websiteUrl ?? ''}
              onChange={(e) =>
                setField('websiteUrl', e.target.value || null)
              }
              placeholder="https://xavia.it"
            />
          </Field>
          <Field label="Factory email (From: line)">
            <Input
              type="email"
              value={settings.factoryEmailFrom ?? ''}
              onChange={(e) =>
                setField('factoryEmailFrom', e.target.value || null)
              }
              placeholder="orders@xavia.it"
            />
          </Field>
        </div>
        <Field label="Address (one line per row)" className="mt-3">
          <textarea
            value={addressDraft}
            onChange={(e) => setAddressDraft(e.target.value)}
            placeholder={'Via Aurelia 123\n00165 Roma RM\nItalia'}
            rows={4}
            className="w-full border border-slate-200 rounded px-3 py-2 text-md resize-y"
          />
        </Field>
      </Card>

      {/* PDF defaults */}
      <Card>
        <div className="text-md font-semibold text-slate-900 mb-3">
          Factory PO defaults
        </div>
        <Field label="Signature block text">
          <Input
            value={settings.signatureBlockText ?? ''}
            onChange={(e) =>
              setField('signatureBlockText', e.target.value || null)
            }
            placeholder="Per: Awais Sulhry / Procurement"
          />
        </Field>
        <Field label="Default PO notes (printed at bottom of every PDF)" className="mt-3">
          <textarea
            value={settings.defaultPoNotes ?? ''}
            onChange={(e) =>
              setField('defaultPoNotes', e.target.value || null)
            }
            placeholder="All goods inspected on arrival. Pre-payment terms net 30."
            rows={3}
            className="w-full border border-slate-200 rounded px-3 py-2 text-md resize-y"
          />
        </Field>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={reload}
          disabled={saving}
          className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
        >
          Discard changes
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="h-8 px-4 text-base bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {saving ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" /> Saving…
            </>
          ) : (
            <>Save changes</>
          )}
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={`block ${className}`}>
      <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold mb-1">
        {label}
      </div>
      {children}
    </label>
  )
}
