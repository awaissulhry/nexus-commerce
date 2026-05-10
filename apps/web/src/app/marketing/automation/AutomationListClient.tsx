'use client'

// MC.11.1 — Marketing automation rule list + create/edit dialog.
//
// Single-page surface. Table of rules with toggle, edit, delete +
// "New rule" button that opens the editor modal. The modal is the
// visual builder: trigger picker → trigger config → action picker
// → action config → save.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Zap,
  Plus,
  AlertTriangle,
  Sparkles,
  Trash2,
  Edit,
  Loader2,
  RefreshCw,
  Power,
  Play,
  LayoutTemplate,
  History,
} from 'lucide-react'
// Power is used by the editor's trigger Section icon — keep it imported
// even though the eslint linter won't see usage in the parent component.
import { useRouter } from 'next/navigation'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  ACTIONS,
  TRIGGERS,
  getActionSpec,
  getTriggerSpec,
} from './_lib/rules'
import {
  normaliseRule,
  type RuleRow,
  type SharedRuleRow,
} from './_lib/types'
import PresetsModal from './_components/PresetsModal'
import CronField from './_components/CronField'

interface Props {
  rules: RuleRow[]
  error: string | null
  apiBase: string
}

export default function AutomationListClient({
  rules: initialRules,
  error,
  apiBase,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [rules, setRules] = useState<RuleRow[]>(initialRules)
  const [editing, setEditing] = useState<RuleRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)

  useEffect(() => {
    setRules(initialRules)
  }, [initialRules])

  const refresh = async () => {
    const res = await fetch(`${apiBase}/api/marketing-automation/rules`, {
      cache: 'no-store',
    })
    if (res.ok) {
      const data = (await res.json()) as { rules: SharedRuleRow[] }
      setRules(data.rules.map(normaliseRule))
    }
  }

  const toggleEnabled = async (rule: RuleRow) => {
    try {
      const res = await fetch(
        `${apiBase}/api/marketing-automation/rules/${encodeURIComponent(rule.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !rule.enabled }),
        },
      )
      if (!res.ok) throw new Error(`Toggle failed (${res.status})`)
      await refresh()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('automation.toggleError'),
      )
    }
  }

  const fireNow = async (rule: RuleRow) => {
    try {
      const res = await fetch(
        `${apiBase}/api/marketing-automation/rules/${encodeURIComponent(rule.id)}/run`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(`Run failed (${res.status})`)
      const data = (await res.json()) as { status: string; reason: string }
      toast({
        title: t('automation.firedToast', {
          name: rule.name,
          status: data.status,
        }),
        description: data.reason,
        tone: 'info',
      })
      await refresh()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('automation.fireError'),
      )
    }
  }

  const remove = async (rule: RuleRow) => {
    if (
      !window.confirm(
        t('automation.deleteConfirm', { name: rule.name }),
      )
    )
      return
    try {
      const res = await fetch(
        `${apiBase}/api/marketing-automation/rules/${encodeURIComponent(rule.id)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      toast.success(t('automation.deleted'))
      await refresh()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('automation.deleteError'),
      )
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('automation.title')}
        description={t('automation.description')}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                router.refresh()
                void refresh()
              }}
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              {t('common.refresh')}
            </Button>
            <Link
              href="/marketing/automation/history"
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              <History className="w-4 h-4" />
              <span className="hidden sm:inline">
                {t('automation.historyBtn')}
              </span>
            </Link>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPresetsOpen(true)}
            >
              <LayoutTemplate className="w-4 h-4 mr-1" />
              {t('automation.presetsBtn')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('automation.createNew')}
            </Button>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {/* AI deferral notice */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/30">
        <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-500" />
        <div>
          <p className="font-medium text-blue-900 dark:text-blue-200">
            {t('automation.aiDeferredTitle')}
          </p>
          <p className="text-blue-800 dark:text-blue-300">
            {t('automation.aiDeferredBody')}
          </p>
        </div>
      </div>

      {rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
          <Zap className="w-8 h-8 text-slate-400" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {t('automation.empty.title')}
          </p>
          <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
            {t('automation.empty.body')}
          </p>
          <div className="flex flex-col items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('automation.createFirst')}
            </Button>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('automation.tryPreset')}
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <RuleRowCard
              key={rule.id}
              rule={rule}
              onToggle={() => toggleEnabled(rule)}
              onEdit={() => setEditing(rule)}
              onDelete={() => remove(rule)}
              onFire={() => fireNow(rule)}
            />
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <RuleEditor
          apiBase={apiBase}
          rule={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={async () => {
            setCreating(false)
            setEditing(null)
            await refresh()
          }}
        />
      )}

      <PresetsModal
        open={presetsOpen}
        onClose={() => setPresetsOpen(false)}
        apiBase={apiBase}
        onApplied={async () => {
          setPresetsOpen(false)
          await refresh()
        }}
      />
    </div>
  )
}

function RuleRowCard({
  rule,
  onToggle,
  onEdit,
  onDelete,
  onFire,
}: {
  rule: RuleRow
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onFire: () => void
}) {
  const { t } = useTranslations()
  const triggerSpec = getTriggerSpec(rule.trigger)
  const actionSpec = getActionSpec(rule.action)
  const aiAction = actionSpec?.requiresAi ?? false
  return (
    <li
      className={`rounded-lg border p-3 shadow-sm transition-shadow hover:shadow-md ${
        rule.enabled
          ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
          : 'border-slate-200 bg-slate-50 opacity-80 dark:border-slate-800 dark:bg-slate-900/60'
      }`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={rule.enabled}
          aria-label={
            rule.enabled
              ? t('automation.disableAria')
              : t('automation.enableAria')
          }
          className={`flex h-8 w-12 items-center rounded-full px-1 transition-colors ${
            rule.enabled
              ? 'bg-emerald-500 justify-end'
              : 'bg-slate-300 justify-start dark:bg-slate-700'
          }`}
        >
          <span className="h-6 w-6 rounded-full bg-white shadow" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {rule.name}
            </p>
            {aiAction && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                <Sparkles className="w-2.5 h-2.5" />
                AI
              </span>
            )}
            {rule.dryRun && (
              <span className="rounded-full bg-slate-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {t('automation.dryRunBadge')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
            <span className="font-medium">
              {t('automation.summary.when')}
            </span>{' '}
            {triggerSpec?.label ?? rule.trigger}
            <span className="mx-1.5 text-slate-400">→</span>
            <span className="font-medium">
              {t('automation.summary.do')}
            </span>{' '}
            {actionSpec?.label ?? rule.action}
          </p>
          {rule.description && (
            <p className="mt-1 text-[11px] italic text-slate-500 dark:text-slate-500">
              {rule.description}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-0.5 text-right text-[11px] text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <Play className="w-3 h-3" />
            {rule.executionCount}
          </span>
          {rule.lastExecutedAt && (
            <span>
              {new Date(rule.lastExecutedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onFire}
            aria-label={t('automation.fireNowAria')}
            title={t('automation.fireNowAria')}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600 dark:hover:bg-slate-800 dark:hover:text-blue-400"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('common.edit')}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <Edit className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('common.delete')}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800 dark:hover:text-red-400"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </li>
  )
}

interface EditorProps {
  apiBase: string
  rule: RuleRow | null
  onClose: () => void
  onSaved: () => void
}

function RuleEditor({ apiBase, rule, onClose, onSaved }: EditorProps) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [name, setName] = useState(rule?.name ?? '')
  const [description, setDescription] = useState(rule?.description ?? '')
  const [trigger, setTrigger] = useState(rule?.trigger ?? TRIGGERS[0]!.id)
  const [triggerConfig, setTriggerConfig] = useState<
    Record<string, unknown>
  >(rule?.triggerConfig ?? {})
  const [action, setAction] = useState(rule?.action ?? ACTIONS[0]!.id)
  const [actionConfig, setActionConfig] = useState<Record<string, unknown>>(
    rule?.actionConfig ?? {},
  )
  const [enabled, setEnabled] = useState(rule?.enabled ?? false)
  const [dryRun, setDryRun] = useState(rule?.dryRun ?? true)
  const [busy, setBusy] = useState(false)

  const triggerSpec = useMemo(() => getTriggerSpec(trigger), [trigger])
  const actionSpec = useMemo(() => getActionSpec(action), [action])

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t('automation.nameRequired'))
      return
    }
    setBusy(true)
    try {
      const url = rule
        ? `${apiBase}/api/marketing-automation/rules/${encodeURIComponent(rule.id)}`
        : `${apiBase}/api/marketing-automation/rules`
      const res = await fetch(url, {
        method: rule ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          trigger,
          triggerConfig,
          action,
          actionConfig,
          enabled,
          dryRun,
        }),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errBody.error ?? `Save failed (${res.status})`)
      }
      toast.success(t('automation.saved'))
      onSaved()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('automation.saveError'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={() => {
        if (busy) return
        onClose()
      }}
      title={
        rule
          ? t('automation.editor.editTitle')
          : t('automation.editor.createTitle')
      }
      size="2xl"
    >
      <ModalBody>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('automation.field.name')}
            </span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('automation.field.namePlaceholder')}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('automation.field.description')}
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>

          <Section
            icon={<Power className="w-3.5 h-3.5 text-slate-400" />}
            title={t('automation.section.trigger')}
          >
            <select
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value)
                setTriggerConfig({})
              }}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {TRIGGERS.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.label} — {spec.description}
                </option>
              ))}
            </select>
            {triggerSpec && triggerSpec.fields.length > 0 && (
              <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50">
                {triggerSpec.fields.map((field) => (
                  <FieldEditor
                    key={field.key}
                    field={field}
                    value={triggerConfig[field.key]}
                    onChange={(v) =>
                      setTriggerConfig({ ...triggerConfig, [field.key]: v })
                    }
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            icon={<Zap className="w-3.5 h-3.5 text-slate-400" />}
            title={t('automation.section.action')}
          >
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value)
                setActionConfig({})
              }}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {ACTIONS.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.requiresAi ? '[AI] ' : ''}
                  {spec.label}
                </option>
              ))}
            </select>
            {actionSpec && (
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                {actionSpec.description}
              </p>
            )}
            {actionSpec?.requiresAi && (
              <div className="mt-1 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] dark:border-amber-800 dark:bg-amber-900/20">
                <Sparkles className="w-3 h-3 flex-shrink-0 mt-0.5 text-amber-500" />
                <p className="text-amber-800 dark:text-amber-200">
                  {t('automation.aiActionWarning')}
                </p>
              </div>
            )}
            {actionSpec && actionSpec.fields.length > 0 && (
              <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50">
                {actionSpec.fields.map((field) => (
                  <FieldEditor
                    key={field.key}
                    field={field}
                    value={actionConfig[field.key]}
                    onChange={(v) =>
                      setActionConfig({ ...actionConfig, [field.key]: v })
                    }
                  />
                ))}
              </div>
            )}
          </Section>

          <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50">
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {t('automation.field.enabled')}
              </span>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {t('automation.field.dryRun')}
              </span>
            </label>
            <p className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
              {t('automation.field.dryRunHint')}
            </p>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
          {t('common.save')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {icon}
        {title}
      </p>
      {children}
    </div>
  )
}

function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: import('./_lib/rules').FieldSpec
  value: unknown
  onChange: (v: unknown) => void
}) {
  const Label = () => (
    <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300">
      {field.label}
      {field.required && <span className="ml-0.5 text-red-500">*</span>}
    </label>
  )
  // MC.11.6 — special-case the `cron` field with the helper UI.
  if (field.key === 'cron') {
    return (
      <CronField
        value={(value as string) ?? ''}
        onChange={(v) => onChange(v)}
        label={field.label}
        required={field.required}
      />
    )
  }
  if (field.kind === 'text' || field.kind === 'asset_kind_select') {
    return (
      <div>
        <Label />
        <input
          type="text"
          value={(value as string) ?? (field.defaultValue as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        {field.hint && (
          <p className="text-[10px] text-slate-500 dark:text-slate-400">
            {field.hint}
          </p>
        )}
      </div>
    )
  }
  if (field.kind === 'textarea') {
    return (
      <div>
        <Label />
        <textarea
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>
    )
  }
  if (field.kind === 'number') {
    return (
      <div>
        <Label />
        <input
          type="number"
          value={
            (value as number) ?? (field.defaultValue as number) ?? ''
          }
          onChange={(e) => onChange(Number(e.target.value))}
          className="mt-1 w-32 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>
    )
  }
  if (field.kind === 'select' || field.kind === 'channel_select') {
    return (
      <div>
        <Label />
        <select
          value={
            (value as string) ?? (field.defaultValue as string) ?? ''
          }
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    )
  }
  if (field.kind === 'boolean') {
    return (
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          checked={(value as boolean) ?? false}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3.5 w-3.5"
        />
        <span>{field.label}</span>
      </label>
    )
  }
  if (field.kind === 'multi_select') {
    const current: string[] = Array.isArray(value)
      ? (value as string[])
      : ((field.defaultValue as string[]) ?? [])
    return (
      <div>
        <Label />
        <div className="mt-1 flex flex-wrap gap-1">
          {(field.options ?? []).map((opt) => {
            const checked = current.includes(opt.value)
            return (
              <label
                key={opt.value}
                className={`inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                  checked
                    ? 'border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-200'
                    : 'border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    if (e.target.checked) onChange([...current, opt.value])
                    else
                      onChange(current.filter((v) => v !== opt.value))
                  }}
                  className="h-3 w-3"
                />
                {opt.label}
              </label>
            )
          })}
        </div>
      </div>
    )
  }
  return null
}
