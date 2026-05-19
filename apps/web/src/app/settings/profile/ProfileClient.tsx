'use client'

/**
 * Settings rebuild — Phase C.4
 *
 * Profile page client. Four sections rendered as separate cards but
 * sharing one Save bar via useSettingsForm:
 *
 *   • Identity — name, email (read-only), phone, avatar (upload)
 *   • Locale — timezone, language, dateFormat, weekStart
 *   • Working hours — start, end
 *   • Password — current + new + confirm, strength meter (separate
 *     save button, since password changes shouldn't piggyback the
 *     locale save)
 *
 * The SaveBar primitive from Phase A is wired here for the first
 * time — the bar at the bottom of the viewport appears when any
 * of the first three sections is dirty, hides when clean.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  Upload,
  Loader2,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
  ShieldCheck,
  Globe,
  Clock,
} from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'
import { useSettingsForm } from '../_shell/SettingsSaveBar'
import { saveProfile, changePassword } from './actions'
import { cn } from '@/lib/utils'

interface ProfileData {
  displayName: string
  email: string
  avatarUrl: string
  phone: string
  timezone: string
  language: string
  dateFormat: string
  weekStart: number | null
  workingHoursStart: string
  workingHoursEnd: string
  hasPassword: boolean
}

interface TwoFactorStatus {
  enabled: boolean
  enrolledAt: string | null
  recoveryCodesRemaining: number
}

interface Props {
  profile: ProfileData | null
  twoFactor: TwoFactorStatus
}

// IANA timezone list — common subset; the operator can free-type in
// any IANA name and the server will accept it. (Full list = 600+
// entries; keeping the dropdown to ~50 of the popular ones keeps
// the UI scannable.)
const COMMON_TIMEZONES = [
  'Europe/Rome',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/London',
  'Europe/Amsterdam',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Athens',
  'Europe/Lisbon',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Pacific/Auckland',
]

const LANGUAGES = [
  { value: 'it-IT', label: 'Italiano' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'es-ES', label: 'Español' },
]

const DATE_FORMATS = [
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (Europe)' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (US)' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (ISO)' },
]

const WEEK_START = [
  { value: 1, label: 'Monday' },
  { value: 0, label: 'Sunday' },
]

const DEFAULTS: ProfileData = {
  displayName: '',
  email: '',
  avatarUrl: '',
  phone: '',
  timezone: 'Europe/Rome',
  language: 'it-IT',
  dateFormat: 'DD/MM/YYYY',
  weekStart: 1,
  workingHoursStart: '09:00',
  workingHoursEnd: '18:00',
  hasPassword: false,
}

export default function ProfileClient({ profile, twoFactor }: Props) {
  const router = useRouter()
  const initial = useMemo<ProfileData>(
    () => ({
      ...DEFAULTS,
      ...(profile ?? {}),
    }),
    [profile],
  )
  const [draft, setDraft] = useState<ProfileData>(initial)
  useEffect(() => setDraft(initial), [initial])

  const isDirty = useMemo(() => {
    // Compare only the user-editable fields. Email + hasPassword are
    // not edited from this surface, so they never drive dirty state.
    const editable: Array<keyof ProfileData> = [
      'displayName',
      'avatarUrl',
      'phone',
      'timezone',
      'language',
      'dateFormat',
      'weekStart',
      'workingHoursStart',
      'workingHoursEnd',
    ]
    for (const k of editable) {
      if ((draft as any)[k] !== (initial as any)[k]) return true
    }
    return false
  }, [draft, initial])

  const onSave = useCallback(async () => {
    const res = await saveProfile({
      displayName: draft.displayName,
      avatarUrl: draft.avatarUrl,
      phone: draft.phone,
      timezone: draft.timezone,
      language: draft.language,
      dateFormat: draft.dateFormat,
      weekStart: draft.weekStart,
      workingHoursStart: draft.workingHoursStart,
      workingHoursEnd: draft.workingHoursEnd,
    })
    if (!res.success) throw new Error('Failed to save profile')
    router.refresh()
  }, [draft, router])

  const onDiscard = useCallback(() => {
    setDraft(initial)
  }, [initial])

  useSettingsForm({
    id: 'settings/profile',
    isDirty,
    onSave,
    onDiscard,
  })

  return (
    <div className="max-w-3xl space-y-6">
      <IdentitySection draft={draft} setDraft={setDraft} />
      <LocaleSection draft={draft} setDraft={setDraft} />
      <WorkingHoursSection draft={draft} setDraft={setDraft} />
      <PasswordSection hasPassword={draft.hasPassword} />
      <SecurityLinkCard twoFactor={twoFactor} />
    </div>
  )
}

// ─── Sections ────────────────────────────────────────────────────

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
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-slate-100 dark:border-slate-800">
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
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
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
      {hint && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          {hint}
        </p>
      )}
    </div>
  )
}

const INPUT_CLS =
  'w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

function IdentitySection({
  draft,
  setDraft,
}: {
  draft: ProfileData
  setDraft: React.Dispatch<React.SetStateAction<ProfileData>>
}) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${getBackendUrl()}/api/settings/profile/avatar`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `Upload failed (${res.status})`)
      }
      const data = (await res.json()) as { avatarUrl: string }
      setDraft((d) => ({ ...d, avatarUrl: data.avatarUrl }))
    } catch (e: any) {
      setUploadError(e?.message ?? String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <Card
      title="Identity"
      description="Your name, email, phone, and avatar."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden border-2 border-slate-300 dark:border-slate-700 flex items-center justify-center">
            {draft.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={draft.avatarUrl}
                alt="Avatar preview"
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-2xl text-slate-400 dark:text-slate-500">
                {draft.displayName?.[0]?.toUpperCase() ?? '👤'}
              </span>
            )}
          </div>
          <div className="flex-1 space-y-1">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleFile(f)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 h-8 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Upload size={13} />
              )}
              {uploading ? 'Uploading…' : 'Upload avatar'}
            </button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              PNG, JPG, or WebP. 4 MB max. Cropped to a square.
            </p>
            {uploadError && (
              <p className="text-xs text-rose-600 dark:text-rose-400 inline-flex items-center gap-1">
                <AlertCircle size={11} /> {uploadError}
              </p>
            )}
          </div>
        </div>

        <Field label="Display name" htmlFor="displayName">
          <input
            id="displayName"
            type="text"
            value={draft.displayName}
            onChange={(e) =>
              setDraft((d) => ({ ...d, displayName: e.target.value }))
            }
            placeholder="Your name"
            className={INPUT_CLS}
            autoComplete="name"
          />
        </Field>

        <Field
          label="Email"
          htmlFor="email"
          hint="Email is not editable here. Phase I (multi-user auth) adds the change-email flow with a verification step."
        >
          <input
            id="email"
            type="email"
            value={draft.email}
            disabled
            className={cn(INPUT_CLS, 'bg-slate-50 dark:bg-slate-900 text-slate-500 cursor-not-allowed')}
          />
        </Field>

        <Field label="Phone" htmlFor="phone" hint="Optional. International format (+39 …) recommended.">
          <input
            id="phone"
            type="tel"
            value={draft.phone}
            onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            placeholder="+39 333 1234567"
            className={INPUT_CLS}
            autoComplete="tel"
          />
        </Field>
      </div>
    </Card>
  )
}

function LocaleSection({
  draft,
  setDraft,
}: {
  draft: ProfileData
  setDraft: React.Dispatch<React.SetStateAction<ProfileData>>
}) {
  return (
    <Card
      title="Locale & timezone"
      description="How dates, numbers, and weeks render across the app."
      icon={<Globe size={14} />}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Timezone" htmlFor="timezone">
          <select
            id="timezone"
            value={draft.timezone}
            onChange={(e) =>
              setDraft((d) => ({ ...d, timezone: e.target.value }))
            }
            className={INPUT_CLS}
          >
            {!COMMON_TIMEZONES.includes(draft.timezone) && draft.timezone && (
              <option value={draft.timezone}>{draft.timezone}</option>
            )}
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Language" htmlFor="language">
          <select
            id="language"
            value={draft.language}
            onChange={(e) =>
              setDraft((d) => ({ ...d, language: e.target.value }))
            }
            className={INPUT_CLS}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Date format" htmlFor="dateFormat">
          <select
            id="dateFormat"
            value={draft.dateFormat}
            onChange={(e) =>
              setDraft((d) => ({ ...d, dateFormat: e.target.value }))
            }
            className={INPUT_CLS}
          >
            {DATE_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Week starts on" htmlFor="weekStart">
          <select
            id="weekStart"
            value={draft.weekStart ?? 1}
            onChange={(e) =>
              setDraft((d) => ({ ...d, weekStart: Number(e.target.value) }))
            }
            className={INPUT_CLS}
          >
            {WEEK_START.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Card>
  )
}

function WorkingHoursSection({
  draft,
  setDraft,
}: {
  draft: ProfileData
  setDraft: React.Dispatch<React.SetStateAction<ProfileData>>
}) {
  return (
    <Card
      title="Working hours"
      description="Used by quiet-hours notification routing (Phase E) and scheduled-publish nudges."
      icon={<Clock size={14} />}
    >
      <div className="grid grid-cols-2 gap-4 max-w-md">
        <Field label="Start" htmlFor="workingHoursStart">
          <input
            id="workingHoursStart"
            type="time"
            value={draft.workingHoursStart}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                workingHoursStart: e.target.value,
              }))
            }
            className={INPUT_CLS}
          />
        </Field>
        <Field label="End" htmlFor="workingHoursEnd">
          <input
            id="workingHoursEnd"
            type="time"
            value={draft.workingHoursEnd}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                workingHoursEnd: e.target.value,
              }))
            }
            className={INPUT_CLS}
          />
        </Field>
      </div>
    </Card>
  )
}

// ─── Password section ────────────────────────────────────────────

function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<
    | { tone: 'success' | 'error'; text: string }
    | null
  >(null)
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const strength = useMemo(() => scoreStrength(next), [next])
  const mismatch = confirm.length > 0 && confirm !== next

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const res = await changePassword({
        currentPassword: current,
        newPassword: next,
        confirmPassword: confirm,
      })
      if (res.success) {
        setMsg({ tone: 'success', text: 'Password changed.' })
        setCurrent('')
        setNext('')
        setConfirm('')
        router.refresh()
      } else {
        setMsg({ tone: 'error', text: res.error ?? 'Failed to change password' })
      }
    } catch (err) {
      setMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Failed to change password',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Password"
      description={
        hasPassword
          ? 'Change your password. We hash with bcrypt (cost 12) before storing.'
          : 'No password set. Pick a strong one.'
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {msg && (
          <div
            className={cn(
              'flex items-start gap-2 p-3 rounded-md text-sm border',
              msg.tone === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                : 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
            )}
          >
            {msg.tone === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}
            <span>{msg.text}</span>
          </div>
        )}

        {hasPassword && (
          <Field label="Current password" htmlFor="current">
            <div className="relative">
              <input
                id="current"
                type={showCurrent ? 'text' : 'password'}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                className={cn(INPUT_CLS, 'pr-10')}
              />
              <button
                type="button"
                onClick={() => setShowCurrent((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label={showCurrent ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showCurrent ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="New password" htmlFor="new">
            <div className="relative">
              <input
                id="new"
                type={showNew ? 'text' : 'password'}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                className={cn(INPUT_CLS, 'pr-10')}
                minLength={8}
              />
              <button
                type="button"
                onClick={() => setShowNew((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label={showNew ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <StrengthMeter score={strength.score} label={strength.label} />
          </Field>
          <Field
            label="Confirm new password"
            htmlFor="confirm"
            hint={mismatch ? 'Confirmation does not match.' : undefined}
          >
            <input
              id="confirm"
              type={showNew ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className={cn(
                INPUT_CLS,
                mismatch && 'border-rose-400 focus:border-rose-500 focus:ring-rose-400',
              )}
              minLength={8}
            />
          </Field>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={
              busy ||
              next.length < 8 ||
              mismatch ||
              (hasPassword && current.length === 0)
            }
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {hasPassword ? 'Change password' : 'Set password'}
          </button>
        </div>
      </form>
    </Card>
  )
}

function scoreStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (pw.length === 0) return { score: 0, label: '' }
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++
  const labels = ['Very weak', 'Weak', 'Okay', 'Good', 'Strong'] as const
  return { score: Math.min(4, s) as 0 | 1 | 2 | 3 | 4, label: labels[Math.min(4, s)] }
}

function StrengthMeter({
  score,
  label,
}: {
  score: 0 | 1 | 2 | 3 | 4
  label: string
}) {
  if (!label) return null
  const colors = [
    'bg-rose-500',
    'bg-rose-400',
    'bg-amber-400',
    'bg-emerald-400',
    'bg-emerald-500',
  ]
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              'flex-1 h-1 rounded',
              i < score
                ? colors[score]
                : 'bg-slate-200 dark:bg-slate-800',
            )}
          />
        ))}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  )
}

// ─── 2FA link card ───────────────────────────────────────────────
// Profile page is the natural place to surface 2FA status; the
// actual enroll/disable flow lives on /settings/security.

function SecurityLinkCard({ twoFactor }: { twoFactor: TwoFactorStatus }) {
  return (
    <Card
      title="Security"
      description="2FA, recovery codes, active sessions, login history."
      icon={<ShieldCheck size={14} />}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Two-factor authentication is{' '}
            {twoFactor.enabled ? (
              <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                <Check size={12} /> enabled
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                <AlertCircle size={12} /> off
              </span>
            )}
            .
          </p>
          {twoFactor.enabled && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {twoFactor.recoveryCodesRemaining} recovery code
              {twoFactor.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
            </p>
          )}
        </div>
        <Link
          href="/settings/security"
          className="inline-flex items-center h-8 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Open security →
        </Link>
      </div>
    </Card>
  )
}
