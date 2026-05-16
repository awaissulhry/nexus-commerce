'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  BarChart3, CheckCircle2, AlertCircle, Loader2, Shield,
  Eye, EyeOff, Trash2, RefreshCw, Zap, Lock,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

interface AdsConnection {
  id: string
  profileId: string
  marketplace: string
  region: string
  accountLabel: string | null
  mode: string
  writesEnabledAt: string | null
  lastWriteAt: string | null
  isActive: boolean
  lastVerifiedAt: string | null
  lastErrorAt: string | null
  lastError: string | null
}

const REGION_OPTIONS = [
  { value: 'EU', label: 'Europe (IT, DE, FR, ES, UK…)' },
  { value: 'NA', label: 'North America (US, CA, MX)' },
  { value: 'FE', label: 'Far East (JP, AU, SG)' },
]

const MARKETPLACE_OPTIONS = [
  { value: 'A1PA7PVP2ZEA0', label: 'Amazon.it (Italy)' },
  { value: 'A1F83G8C2ARO7P', label: 'Amazon.co.uk (UK)' },
  { value: 'A1RKKUPIHCS9HS', label: 'Amazon.de (Germany)' },
  { value: 'A13V1IB3VIYZZH', label: 'Amazon.fr (France)' },
  { value: 'APJ6JRA9NG5V4', label: 'Amazon.es (Spain)' },
  { value: 'ATVPDKIKX0DER', label: 'Amazon.com (US)' },
]

function StatusBadge({ mode, writesEnabledAt }: { mode: string; writesEnabledAt: string | null }) {
  if (mode === 'production' && writesEnabledAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        <Zap className="h-3 w-3" /> Live + writes enabled
      </span>
    )
  }
  if (mode === 'production') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
        <Shield className="h-3 w-3" /> Live (read-only)
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      Sandbox
    </span>
  )
}

export default function AdvertisingSettingsPage() {
  const [connections, setConnections] = useState<AdsConnection[]>([])
  const [adsMode, setAdsMode] = useState<string>('sandbox')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [showSecrets, setShowSecrets] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [form, setForm] = useState({
    profileId: '',
    marketplace: 'A1PA7PVP2ZEA0',
    region: 'EU',
    accountLabel: '',
    clientId: '',
    clientSecret: '',
    refreshToken: '',
  })

  const fetchConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/connections`)
      if (res.ok) {
        const data = await res.json()
        setConnections(data.items ?? [])
        setAdsMode(data.adsMode ?? 'sandbox')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchConnections() }, [fetchConnections])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Save failed')
      } else {
        setSuccess('Connection saved. Use "Test" to verify credentials.')
        setForm({ profileId: '', marketplace: 'A1PA7PVP2ZEA0', region: 'EU', accountLabel: '', clientId: '', clientSecret: '', refreshToken: '' })
        fetchConnections()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (profileId: string) => {
    setTesting(profileId)
    setTestResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/ads-connection/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
      })
      const data = await res.json()
      setTestResult({
        ok: data.ok,
        message: data.ok
          ? `Connected — ${data.profileCount} profile(s) visible`
          : (data.error ?? 'Test failed'),
      })
    } finally {
      setTesting(null)
    }
  }

  const handleDelete = async (profileId: string) => {
    if (!confirm(`Remove connection for profile ${profileId}?`)) return
    await fetch(`${getBackendUrl()}/api/advertising/connections/${profileId}`, { method: 'DELETE' })
    fetchConnections()
  }

  const handleEnableWrites = async (profileId: string) => {
    if (!confirm('Enable live writes? This will allow the system to change bids and budgets on Amazon.')) return
    // First set mode=production via preview, then enable writes
    const previewRes = await fetch(`${getBackendUrl()}/api/advertising/connection/preview-writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    })
    if (!previewRes.ok) {
      const d = await previewRes.json()
      alert(`Preview failed: ${d.error ?? 'unknown error'}`)
      return
    }
    const writeRes = await fetch(`${getBackendUrl()}/api/advertising/connection/enable-writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    })
    if (writeRes.ok) {
      fetchConnections()
    } else {
      const d = await writeRes.json()
      alert(`Enable writes failed: ${d.error ?? 'unknown error'}`)
    }
  }

  const handleDisableWrites = async (profileId: string) => {
    await fetch(`${getBackendUrl()}/api/advertising/connection/disable-writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    })
    fetchConnections()
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 className="h-5 w-5 text-blue-600" />
            <h1 className="text-xl font-semibold text-slate-900">Amazon Advertising API</h1>
          </div>
          <p className="text-sm text-slate-500">
            Connect your Amazon Advertising account to sync campaigns, pull metrics, and enable
            automated bid management. Credentials are encrypted with AES-256-GCM before storage.
          </p>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
          <span className={`h-1.5 w-1.5 rounded-full ${adsMode === 'live' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
          <span className="text-slate-600">Server mode: <strong>{adsMode}</strong></span>
        </div>
      </div>

      {adsMode === 'sandbox' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Sandbox mode active</strong> — credentials are saved but API calls return fixture data.
          Set <code className="font-mono bg-amber-100 px-1 rounded">NEXUS_AMAZON_ADS_MODE=live</code> in
          Railway env vars to activate real API calls.
        </div>
      )}

      {/* Existing connections */}
      {loading ? (
        <Card><div className="py-8 text-center text-slate-400 text-sm flex items-center justify-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div></Card>
      ) : connections.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Active Connections</h2>
          {connections.map((conn) => (
            <Card key={conn.id}>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900 text-sm truncate">
                      {conn.accountLabel ?? conn.profileId}
                    </span>
                    <StatusBadge mode={conn.mode} writesEnabledAt={conn.writesEnabledAt} />
                  </div>
                  <div className="text-xs text-slate-500 space-x-3">
                    <span>Profile: <code className="font-mono">{conn.profileId}</code></span>
                    <span>Region: {conn.region}</span>
                    <span>Marketplace: {conn.marketplace}</span>
                  </div>
                  {conn.lastError && (
                    <div className="flex items-center gap-1 text-xs text-rose-600">
                      <AlertCircle className="h-3 w-3 flex-shrink-0" />
                      {conn.lastError}
                    </div>
                  )}
                  {testResult && testing === null && (
                    <div className={`flex items-center gap-1 text-xs ${testResult.ok ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {testResult.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                      {testResult.message}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
                  <button
                    onClick={() => handleTest(conn.profileId)}
                    disabled={testing === conn.profileId}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {testing === conn.profileId ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Test
                  </button>
                  {conn.writesEnabledAt ? (
                    <button
                      onClick={() => handleDisableWrites(conn.profileId)}
                      className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100"
                    >
                      <Lock className="h-3 w-3" /> Disable writes
                    </button>
                  ) : (
                    <button
                      onClick={() => handleEnableWrites(conn.profileId)}
                      className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100"
                    >
                      <Zap className="h-3 w-3" /> Enable writes
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(conn.profileId)}
                    className="inline-flex items-center gap-1 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Add / update connection form */}
      <Card>
        <h2 className="text-sm font-semibold text-slate-800 mb-4">
          {connections.length > 0 ? 'Add Another Connection' : 'Connect Amazon Advertising'}
        </h2>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Profile ID *</label>
              <input
                type="text"
                required
                placeholder="e.g. 4141223456789012"
                value={form.profileId}
                onChange={(e) => setForm((f) => ({ ...f, profileId: e.target.value }))}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-slate-400">Find via GET /v2/profiles in sandbox</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Account Label</label>
              <input
                type="text"
                placeholder="e.g. Xavia IT"
                value={form.accountLabel}
                onChange={(e) => setForm((f) => ({ ...f, accountLabel: e.target.value }))}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Marketplace *</label>
              <select
                value={form.marketplace}
                onChange={(e) => setForm((f) => ({ ...f, marketplace: e.target.value }))}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {MARKETPLACE_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Region *</label>
              <select
                value={form.region}
                onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {REGION_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>

          <hr className="border-slate-100" />

          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">LWA Credentials</span>
            <button
              type="button"
              onClick={() => setShowSecrets((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
            >
              {showSecrets ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showSecrets ? 'Hide' : 'Show'}
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Client ID *</label>
            <input
              type={showSecrets ? 'text' : 'password'}
              required
              placeholder="amzn1.application-oa2-client...."
              value={form.clientId}
              onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Client Secret *</label>
            <input
              type={showSecrets ? 'text' : 'password'}
              required
              value={form.clientSecret}
              onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Refresh Token *</label>
            <input
              type={showSecrets ? 'text' : 'password'}
              required
              placeholder="Atzr|..."
              value={form.refreshToken}
              onChange={(e) => setForm((f) => ({ ...f, refreshToken: e.target.value }))}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-slate-400">
              Requires <code className="font-mono">advertising::campaign_management</code> scope — separate from your SP-API refresh token
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              {success}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            {saving ? 'Saving…' : 'Save & Encrypt Credentials'}
          </button>
        </form>
      </Card>

      {/* Setup guide */}
      <Card>
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Setup Guide</h2>
        <ol className="space-y-2 text-sm text-slate-600 list-decimal list-inside">
          <li>Go to <strong>advertising.amazon.com → Partner Network → Developer Console</strong></li>
          <li>Register an app with scope <code className="font-mono bg-slate-100 px-1 rounded">advertising::campaign_management</code></li>
          <li>Complete the LWA OAuth consent flow to get your <strong>refresh token</strong></li>
          <li>Enter the credentials above and click Save</li>
          <li>Click <strong>Test</strong> to verify the connection works</li>
          <li>Set <code className="font-mono bg-slate-100 px-1 rounded">NEXUS_AMAZON_ADS_MODE=live</code> in Railway env vars</li>
          <li>Once metrics are flowing, use <strong>Enable writes</strong> to allow bid automation</li>
        </ol>
      </Card>
    </div>
  )
}
