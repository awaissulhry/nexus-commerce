'use client'

// CR.6 — Carrier configuration drawer.
//
// Replaces the in-card inline accordion form with a side-drawer
// modal that scales to multiple tabs as later commits add Services
// (CR.7), Defaults (CR.13), Performance (CR.15), Activity (later).
//
// Today's tabs:
//   • Credentials — connect / update / test / disconnect
//   • Webhooks    — Sendcloud webhook URL display + copy
//
// All tabs share a sticky footer with Save + Test buttons. Footer is
// always visible so operators don't need to scroll on smaller
// screens. Drawer-right placement (640px max) so the marketplace
// stays partially visible behind it for context.

import { useEffect, useMemo, useState } from 'react'
import { Copy, Check, Lock, AlertCircle, ExternalLink } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Tabs, type Tab } from '@/components/ui/Tabs'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'

type Field = {
  key: string
  labelKey: string
  password?: boolean
  type?: 'number'
}

export interface CarrierDef {
  code: string
  label: string
  description: string
  docsUrl: string | null
  fields: Field[]
}

export interface CarrierRow {
  isActive: boolean
  hasCredentials: boolean
  lastVerifiedAt?: string | null
  lastErrorAt?: string | null
  lastError?: string | null
  mode?: 'sandbox' | 'production'
}

interface Props {
  def: CarrierDef
  carrier: CarrierRow | null
  open: boolean
  onClose: () => void
  onChanged: () => void
}

type TabId = 'credentials' | 'webhooks'

export function CarrierConfigDrawer({ def, carrier, open, onClose, onChanged }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()

  const [activeTab, setActiveTab] = useState<TabId>('credentials')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  const isConnected = !!carrier?.isActive

  // Reset transient state every time the drawer opens for a different
  // carrier — prevents leaking secrets between carrier drawers.
  useEffect(() => {
    if (open) {
      setActiveTab('credentials')
      setFields({})
      setDirty(false)
    }
  }, [open, def.code])

  const updateField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const handleClose = async () => {
    if (dirty) {
      // Mirror the confirm-before-close pattern from /products drawer.
      const ok = await askConfirm({
        title: 'Discard unsaved changes?',
        description: 'Your credential changes will be lost.',
        confirmLabel: 'Discard',
        tone: 'danger',
      })
      if (!ok) return
    }
    onClose()
  }

  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = {}
      for (const f of def.fields) {
        const v = fields[f.key]
        if (f.type === 'number') body[f.key] = v ? Number(v) : undefined
        else body[f.key] = v
      }
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/connect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Connect failed')
      }
      setDirty(false)
      setFields({})
      onChanged()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/test`,
        { method: 'POST' },
      )
      const body = await res.json().catch(() => ({}))
      if (body.dryRun) {
        toast.success(t('carriers.test.dryRun'))
        return
      }
      if (body.ok) {
        toast.success(t('carriers.test.success', { username: body.username ?? '?' }))
      } else {
        toast.error(t('carriers.test.failed', { reason: body.error ?? body.reason ?? 'unknown' }))
      }
    } catch (e: any) {
      toast.error(t('carriers.test.failed', { reason: e?.message ?? 'unknown' }))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    const ok = await askConfirm({
      title: t('carriers.disconnect.title', { name: def.label }),
      description: t('carriers.disconnect.description'),
      confirmLabel: t('carriers.action.disconnect'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/disconnect`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error('Disconnect failed')
      onChanged()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Tabs are gated by carrier code. Webhooks tab is Sendcloud-only;
  // Buy Shipping doesn't expose a webhook surface (Amazon pushes via
  // SP-API notifications, configured at the seller-account level
  // outside Nexus).
  const tabs: Tab[] = useMemo(() => {
    const list: Tab[] = [{ id: 'credentials', label: t('carriers.title') + ' · ' + (t('carriers.field.publicKey') as string).split(' ')[0] }]
    if (def.code === 'SENDCLOUD') {
      list.push({ id: 'webhooks', label: 'Webhooks' })
    }
    return list
  }, [def.code, t])

  const headerStatus = isConnected ? (
    <Badge variant="success" size="sm">{t('carriers.status.connected')}</Badge>
  ) : (
    <Badge variant="default" size="sm">{t('carriers.status.notConnected')}</Badge>
  )

  return (
    <Modal
      open={open}
      onClose={handleClose}
      placement="drawer-right"
      size="xl"
      title={
        <div className="flex items-center gap-2 flex-wrap">
          <span>{def.label}</span>
          {headerStatus}
          {carrier?.mode === 'sandbox' && <Badge variant="default" size="sm">sandbox</Badge>}
        </div>
      }
      description={def.description}
      dismissOnBackdrop={!dirty}
    >
      <ModalBody className="px-0 py-0">
        <div className="px-6 pt-3">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={(id) => setActiveTab(id as TabId)}
          />
        </div>

        <div className="px-6 py-5">
          {activeTab === 'credentials' && (
            <CredentialsTab
              def={def}
              fields={fields}
              onField={updateField}
            />
          )}
          {activeTab === 'webhooks' && def.code === 'SENDCLOUD' && (
            <WebhooksTab />
          )}
        </div>
      </ModalBody>

      <ModalFooter className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isConnected && (
            <Button variant="danger" size="sm" onClick={disconnect} disabled={busy}>
              {t('carriers.action.disconnect')}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isConnected && (
            <Button variant="secondary" size="sm" onClick={testConnection} disabled={busy}>
              {t('carriers.action.test')}
            </Button>
          )}
          {def.fields.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              loading={busy}
              icon={<Lock size={11} />}
              disabled={!dirty && isConnected}
              title={!dirty && isConnected ? 'No changes' : undefined}
            >
              {isConnected ? t('common.save') : t('carriers.action.connect')}
            </Button>
          )}
          {def.fields.length === 0 && !isConnected && (
            <Button variant="primary" size="sm" onClick={save} loading={busy}>
              {t('carriers.action.connect')}
            </Button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  )
}

// ── Credentials tab ────────────────────────────────────────────────
function CredentialsTab({
  def, fields, onField,
}: {
  def: CarrierDef
  fields: Record<string, string>
  onField: (key: string, value: string) => void
}) {
  const { t } = useTranslations()

  if (def.fields.length === 0) {
    return (
      <div className="text-base text-slate-600 dark:text-slate-300 space-y-2">
        <p>{def.description}</p>
        {def.code === 'AMAZON_BUY_SHIPPING' && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Uses your existing Seller Central credentials (configured at /settings/connections).
            Set <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs">NEXUS_ENABLE_AMAZON_BUY_SHIPPING=true</code> to flip from sandbox to production.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {def.fields.map((f) => (
        <div key={f.key}>
          <label
            htmlFor={`field-${f.key}`}
            className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block"
          >
            {t(f.labelKey)}
          </label>
          <input
            id={`field-${f.key}`}
            type={f.password ? 'password' : f.type === 'number' ? 'number' : 'text'}
            value={fields[f.key] ?? ''}
            onChange={(e) => onField(f.key, e.target.value)}
            className="h-9 w-full px-3 text-base font-mono border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ))}
      {def.docsUrl && (
        <a
          href={def.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
        >
          {t('carriers.action.docs')} <ExternalLink size={10} />
        </a>
      )}
    </div>
  )
}

// ── Webhooks tab ───────────────────────────────────────────────────
// Surfaces the Sendcloud webhook URL operators paste into Sendcloud's
// integration panel. Today the signing secret comes from
// NEXUS_SENDCLOUD_WEBHOOK_SECRET env var; the UI just displays the URL
// + a hint. Per-carrier secret rotation from the UI lands in a later
// commit alongside Carrier.webhookSecret persistence.
function WebhooksTab() {
  const [copied, setCopied] = useState(false)
  const url = useMemo(() => `${getBackendUrl()}/api/webhooks/sendcloud`, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — operator pastes manually */
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
          Webhook URL
        </div>
        <div className="flex items-stretch gap-1">
          <code className="flex-1 px-3 py-2 text-sm font-mono bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-100 break-all">
            {url}
          </code>
          <Button variant="secondary" size="sm" onClick={copy} icon={copied ? <Check size={11} /> : <Copy size={11} />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Paste this URL into Sendcloud → Settings → Integrations → Webhooks. Send all parcel-status events; signature header is <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs">Sendcloud-Signature</code>.
        </p>
      </div>

      <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3">
        <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
        <div>
          The signing secret is currently configured via the <code className="px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 rounded text-xs">NEXUS_SENDCLOUD_WEBHOOK_SECRET</code> environment variable. Per-carrier secret rotation from this drawer lands in a follow-up commit.
        </div>
      </div>
    </div>
  )
}
