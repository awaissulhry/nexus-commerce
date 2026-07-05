'use client'

/**
 * Settings rebuild — Phase E.2
 *
 * /settings/notifications. Two cards:
 *
 *   1. Quiet hours — single time-range that suppresses delivery
 *      across all event-types (digest-able events still queue;
 *      instant ones drop, mirroring how mobile DND works).
 *
 *   2. Event preferences table — one row per known event-type.
 *      Columns:
 *        • event-type label + description
 *        • In-app / Email / SMS toggles
 *        • Cadence: instant | hourly | daily | off
 *        • Channels: chip multi-select scoping delivery to specific
 *          marketplaces; empty = every channel
 *
 * SaveBar wired via useSettingsForm — Save / Discard / ⌘S all work.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bell,
  Mail,
  MessageSquare,
  MonitorSmartphone,
  Moon,
  Check,
  X,
} from 'lucide-react'
import { useSettingsForm } from '../_shell/SettingsSaveBar'
import { saveNotificationPreferences } from './actions'
import { EVENT_TYPES } from './event-types'
import { cn } from '@/lib/utils'
import { Listbox } from '@/design-system/components/Listbox'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'

export interface LoadedPref {
  eventType: string
  email: boolean
  sms: boolean
  inApp: boolean
  channelFilter: string[]
  digestCadence: string
}

const CADENCES = [
  { value: 'instant', label: 'Instant' },
  { value: 'hourly', label: 'Hourly digest' },
  { value: 'daily', label: 'Daily digest' },
  { value: 'off', label: 'Off' },
] as const

// Channels the operator can scope delivery to. Mirrors the project's
// "active channel scope" memory — Amazon + eBay + Shopify only.
const CHANNEL_OPTIONS = [
  { value: 'AMAZON_IT', label: 'Amazon IT' },
  { value: 'AMAZON_DE', label: 'Amazon DE' },
  { value: 'AMAZON_FR', label: 'Amazon FR' },
  { value: 'AMAZON_ES', label: 'Amazon ES' },
  { value: 'AMAZON_UK', label: 'Amazon UK' },
  { value: 'EBAY_IT', label: 'eBay IT' },
  { value: 'EBAY_DE', label: 'eBay DE' },
  { value: 'EBAY_FR', label: 'eBay FR' },
  { value: 'EBAY_ES', label: 'eBay ES' },
  { value: 'EBAY_UK', label: 'eBay UK' },
  { value: 'SHOPIFY', label: 'Shopify' },
] as const

interface Props {
  initialPrefs: LoadedPref[]
  quietHoursStart: string
  quietHoursEnd: string
  timezone: string | null
}

function prefsEqual(a: LoadedPref[], b: LoadedPref[]): boolean {
  if (a.length !== b.length) return false
  const byKey = new Map(b.map((p) => [p.eventType, p]))
  for (const ap of a) {
    const bp = byKey.get(ap.eventType)
    if (!bp) return false
    if (
      ap.email !== bp.email ||
      ap.sms !== bp.sms ||
      ap.inApp !== bp.inApp ||
      ap.digestCadence !== bp.digestCadence ||
      ap.channelFilter.length !== bp.channelFilter.length ||
      !ap.channelFilter.every((c) => bp.channelFilter.includes(c))
    ) {
      return false
    }
  }
  return true
}

export default function NotificationsClient({
  initialPrefs,
  quietHoursStart,
  quietHoursEnd,
  timezone,
}: Props) {
  const router = useRouter()
  const [prefs, setPrefs] = useState<LoadedPref[]>(initialPrefs)
  const [qhStart, setQhStart] = useState(quietHoursStart)
  const [qhEnd, setQhEnd] = useState(quietHoursEnd)
  useEffect(() => setPrefs(initialPrefs), [initialPrefs])
  useEffect(() => setQhStart(quietHoursStart), [quietHoursStart])
  useEffect(() => setQhEnd(quietHoursEnd), [quietHoursEnd])

  const isDirty = useMemo(
    () =>
      !prefsEqual(prefs, initialPrefs) ||
      qhStart !== quietHoursStart ||
      qhEnd !== quietHoursEnd,
    [prefs, initialPrefs, qhStart, qhEnd, quietHoursStart, quietHoursEnd],
  )

  const onSave = useCallback(async () => {
    const res = await saveNotificationPreferences({
      prefs: prefs.map((p) => ({
        eventType: p.eventType,
        email: p.email,
        sms: p.sms,
        inApp: p.inApp,
        channelFilter: p.channelFilter,
        digestCadence: p.digestCadence,
      })),
      quietHours: {
        quietHoursStart: qhStart.trim() || null,
        quietHoursEnd: qhEnd.trim() || null,
      },
    })
    if (!res.success) {
      const detail = res.errors
        ? res.errors.map((e) => `${e.eventType}: ${e.reason}`).join(' · ')
        : 'Validation failed'
      throw new Error(detail)
    }
    router.refresh()
  }, [prefs, qhStart, qhEnd, router])

  const onDiscard = useCallback(() => {
    setPrefs(initialPrefs)
    setQhStart(quietHoursStart)
    setQhEnd(quietHoursEnd)
  }, [initialPrefs, quietHoursStart, quietHoursEnd])

  useSettingsForm({
    id: 'settings/notifications',
    isDirty,
    onSave,
    onDiscard,
  })

  return (
    <div className="max-w-4xl space-y-6">
      <QuietHoursCard
        start={qhStart}
        end={qhEnd}
        timezone={timezone}
        onChange={(s, e) => {
          setQhStart(s)
          setQhEnd(e)
        }}
      />
      <PrefsTable prefs={prefs} onChange={setPrefs} />
      {/* RT.17 — Browser desktop notifications. State persists in
          localStorage (per-browser), independent of the server-backed
          email/SMS prefs above. */}
      <BrowserNotificationsCard />
    </div>
  )
}

// ─── Browser desktop notifications (RT.17) ───────────────────────

import {
  ALERT_CLASS_META,
  DEFAULT_CONFIG,
  fireBrowserNotification,
  loadBrowserNotificationConfig,
  requestBrowserNotificationPermission,
  saveBrowserNotificationConfig,
  type AlertClass,
} from '@/lib/notifications/browser-notifications'

function BrowserNotificationsCard() {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setConfig(loadBrowserNotificationConfig())
    if (typeof Notification !== 'undefined') {
      setPermission(Notification.permission)
    }
    setMounted(true)
  }, [])

  if (!mounted) return null

  const persist = (next: typeof config) => {
    setConfig(next)
    saveBrowserNotificationConfig(next)
  }

  const requestPermission = async () => {
    const r = await requestBrowserNotificationPermission()
    setPermission(r)
    if (r === 'granted' && !config.enabled) {
      persist({ ...config, enabled: true })
    }
  }

  const sendTest = () => {
    const fired = fireBrowserNotification('dlq', 'Nexus — test notification', {
      body: 'If you see this, browser notifications are working.',
    })
    if (!fired) {
      alert(
        'Test notification was blocked. Check that the global toggle is ON, the DLQ class is enabled, and browser permission was granted.',
      )
    }
  }

  const permissionLabel =
    permission === 'granted'
      ? 'Granted'
      : permission === 'denied'
        ? 'Blocked (re-enable in site settings)'
        : 'Not requested yet'

  return (
    <section className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-subtle dark:border-slate-800">
        <div className="shrink-0 w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
          <MonitorSmartphone size={14} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Browser desktop notifications
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Per-browser opt-in. Independent of the email / SMS settings above.
            Stored locally (no server round-trip) because browser-notification
            permission is per-browser-profile.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 p-3 rounded border border-default dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Permission status
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {permissionLabel}
            </div>
          </div>
          {permission !== 'granted' && (
            <button
              type="button"
              onClick={requestPermission}
              className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              Request permission
            </button>
          )}
          {permission === 'granted' && (
            <button
              type="button"
              onClick={sendTest}
              className="px-3 py-1.5 text-xs font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Send test
            </button>
          )}
        </div>

        <label className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Enable browser notifications
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Master switch — disable to silence all classes without
              touching individual toggles.
            </div>
          </div>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => persist({ ...config, enabled: e.target.checked })}
            className="w-4 h-4 rounded border-slate-300"
          />
        </label>

        <div className="space-y-2 pt-2 border-t border-subtle dark:border-slate-800">
          <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
            Per-class toggles
          </div>
          {(Object.keys(ALERT_CLASS_META) as AlertClass[]).map((k) => (
            <label
              key={k}
              className="flex items-center justify-between gap-3 p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              <div>
                <div className="text-sm text-slate-900 dark:text-slate-100">
                  {ALERT_CLASS_META[k].label}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {ALERT_CLASS_META[k].description}
                </div>
              </div>
              <input
                type="checkbox"
                checked={config.classes[k]}
                disabled={!config.enabled}
                onChange={(e) =>
                  persist({
                    ...config,
                    classes: { ...config.classes, [k]: e.target.checked },
                  })
                }
                className="w-4 h-4 rounded border-slate-300 disabled:opacity-40"
              />
            </label>
          ))}
        </div>

        <div className="pt-2 border-t border-subtle dark:border-slate-800">
          <label className="block text-sm">
            <span className="text-slate-900 dark:text-slate-100">
              High-value order threshold (EUR)
            </span>
            <input
              type="number"
              min={0}
              step={10}
              value={config.highValueOrderThresholdCents / 100}
              disabled={!config.enabled || !config.classes.highValueOrder}
              onChange={(e) =>
                persist({
                  ...config,
                  highValueOrderThresholdCents: Math.round(
                    Number(e.target.value || 0) * 100,
                  ),
                })
              }
              className="mt-1 block w-32 px-2 py-1 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900 disabled:opacity-40"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Orders at or above this total fire a high-value-order
              notification when the class is enabled.
            </p>
          </label>
        </div>
      </div>
    </section>
  )
}

// ─── Quiet hours card ────────────────────────────────────────────

function QuietHoursCard({
  start,
  end,
  timezone,
  onChange,
}: {
  start: string
  end: string
  timezone: string | null
  onChange: (start: string, end: string) => void
}) {
  const enabled = start.length > 0 || end.length > 0
  const wraps = enabled && start.length > 0 && end.length > 0 && start > end
  return (
    <section className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-subtle dark:border-slate-800">
        <div className="shrink-0 w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
          <Moon size={14} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Quiet hours
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Suppress notifications during this window
            {timezone && (
              <>
                {' '}
                · timezone{' '}
                <span className="font-mono text-slate-700 dark:text-slate-300">
                  {timezone}
                </span>
              </>
            )}
            . Digest-able events still queue; instant ones drop.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <div>
          <label
            htmlFor="qh-start"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
          >
            From
          </label>
          <input
            id="qh-start"
            type="time"
            value={start}
            onChange={(e) => onChange(e.target.value, end)}
            className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label
            htmlFor="qh-end"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
          >
            To
          </label>
          <input
            id="qh-end"
            type="time"
            value={end}
            onChange={(e) => onChange(start, e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        {enabled && (
          <button
            type="button"
            onClick={() => onChange('', '')}
            className="h-9 px-3 rounded-md text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border border-default dark:border-slate-800"
          >
            Clear
          </button>
        )}
      </div>
      {wraps && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
          Range wraps midnight — applies from {start} until {end} the next day.
        </p>
      )}
    </section>
  )
}

// ─── Per-event preferences table ─────────────────────────────────

function PrefsTable({
  prefs,
  onChange,
}: {
  prefs: LoadedPref[]
  onChange: (p: LoadedPref[]) => void
}) {
  const update = (eventType: string, patch: Partial<LoadedPref>) => {
    onChange(
      prefs.map((p) => (p.eventType === eventType ? { ...p, ...patch } : p)),
    )
  }
  return (
    <section className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-lg overflow-hidden">
      <div className="flex items-start gap-3 px-5 py-4 border-b border-subtle dark:border-slate-800">
        <div className="shrink-0 w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
          <Bell size={14} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Event preferences
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Pick channels + cadence + which marketplaces apply, per event type.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-950/50 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Event</th>
              <th className="text-center px-2 py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  <MonitorSmartphone size={12} /> In-app
                </span>
              </th>
              <th className="text-center px-2 py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  <Mail size={12} /> Email
                </span>
              </th>
              <th className="text-center px-2 py-2 font-medium">
                <span className="inline-flex items-center gap-1">
                  <MessageSquare size={12} /> SMS
                </span>
              </th>
              <th className="text-left px-2 py-2 font-medium">Cadence</th>
              <th className="text-left px-4 py-2 font-medium">Marketplaces</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {EVENT_TYPES.map((ev) => {
              const pref =
                prefs.find((p) => p.eventType === ev.key) ?? {
                  eventType: ev.key,
                  ...ev.defaults,
                  channelFilter: [],
                }
              const off = pref.digestCadence === 'off'
              return (
                <tr
                  key={ev.key}
                  className={cn(
                    'align-top hover:bg-slate-50/60 dark:hover:bg-slate-950/40',
                    off && 'opacity-50',
                  )}
                >
                  <td className="px-4 py-3 max-w-xs">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {ev.label}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {ev.description}
                    </div>
                  </td>
                  <td className="text-center px-2 py-3">
                    <Toggle
                      checked={pref.inApp}
                      disabled={off}
                      onChange={(v) => update(ev.key, { inApp: v })}
                      label={`In-app for ${ev.label}`}
                    />
                  </td>
                  <td className="text-center px-2 py-3">
                    <Toggle
                      checked={pref.email}
                      disabled={off}
                      onChange={(v) => update(ev.key, { email: v })}
                      label={`Email for ${ev.label}`}
                    />
                  </td>
                  <td className="text-center px-2 py-3">
                    <Toggle
                      checked={pref.sms}
                      disabled={off}
                      onChange={(v) => update(ev.key, { sms: v })}
                      label={`SMS for ${ev.label}`}
                    />
                  </td>
                  <td className="px-2 py-3">
                    <Listbox
                      value={pref.digestCadence}
                      onChange={(v) => update(ev.key, { digestCadence: v })}
                      options={CADENCES.map((c) => ({
                        value: c.value,
                        label: c.label,
                      }))}
                      ariaLabel={`Cadence for ${ev.label}`}
                      className="w-36"
                    />
                  </td>
                  <td className="px-4 py-3 max-w-md">
                    <ChannelMultiSelect
                      value={pref.channelFilter}
                      onChange={(v) => update(ev.key, { channelFilter: v })}
                      disabled={off}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 rounded-full transition-colors',
        disabled
          ? 'bg-slate-200 dark:bg-slate-800 cursor-not-allowed'
          : checked
            ? 'bg-blue-600'
            : 'bg-slate-300 dark:bg-slate-700',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

function ChannelMultiSelect({
  value,
  onChange,
  disabled,
}: {
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const allOn = value.length === 0
  const toggle = (chan: string) => {
    if (value.includes(chan)) {
      onChange(value.filter((c) => c !== chan))
    } else {
      onChange([...value, chan])
    }
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={() => onChange([])}
        disabled={disabled}
        className={cn(
          'inline-flex items-center h-6 px-2 rounded-full text-xs border transition-colors',
          allOn
            ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-700 dark:border-slate-700'
            : 'bg-white text-slate-600 border-slate-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-400 hover:border-slate-400',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        {allOn && <Check size={10} className="mr-1" />}
        All channels
      </button>
      {!allOn && (
        <>
          {value.map((chan) => {
            const opt = CHANNEL_OPTIONS.find((o) => o.value === chan)
            return (
              <button
                key={chan}
                type="button"
                onClick={() => toggle(chan)}
                disabled={disabled}
                className={cn(
                  'inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full text-xs border bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
                  disabled && 'opacity-50 cursor-not-allowed',
                )}
              >
                {opt?.label ?? chan}
                <X size={10} />
              </button>
            )
          })}
          <details className="relative">
            <summary
              className={cn(
                'inline-flex items-center h-6 px-2 rounded-full text-xs border cursor-pointer list-none bg-white text-slate-600 border-dashed border-slate-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-400 hover:border-slate-400',
                disabled && 'opacity-50 cursor-not-allowed',
              )}
            >
              + Add
            </summary>
            <div className="absolute z-10 mt-1 w-48 max-h-64 overflow-y-auto rounded-md border border-default bg-white shadow-lg dark:bg-slate-900 dark:border-slate-700 p-1">
              {CHANNEL_OPTIONS.filter((o) => !value.includes(o.value)).map(
                (o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="w-full text-left px-2 py-1 text-sm rounded text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    {o.label}
                  </button>
                ),
              )}
              {value.length === CHANNEL_OPTIONS.length && (
                <p className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400">
                  All channels added.
                </p>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  )
}
