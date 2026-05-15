'use client'

// MC.11.2 — preset picker modal. Click a preset → POST it as a new
// rule (in dry-run + disabled by default so the operator reviews
// before enabling). For presets that need editing (e.g., brand
// watermark), the post-create UX redirects to the editor.

import { useState } from 'react'
import {
  Sparkles,
  Loader2,
  Zap,
  Upload,
  Link as LinkIcon,
  Plug,
  Calendar,
  AlertTriangle,
} from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { RULE_PRESETS, type RulePreset } from '../_lib/presets'

interface Props {
  open: boolean
  onClose: () => void
  apiBase: string
  onApplied: () => void
}

const CATEGORY_ICON: Record<RulePreset['category'], typeof Zap> = {
  on_upload: Upload,
  on_attach: LinkIcon,
  on_channel: Plug,
  scheduled: Calendar,
}

export default function PresetsModal({
  open,
  onClose,
  apiBase,
  onApplied,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  const apply = async (preset: RulePreset) => {
    setBusy(preset.id)
    try {
      const res = await fetch(
        `${apiBase}/api/marketing-automation/rules`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: preset.name,
            description: preset.description,
            trigger: preset.trigger,
            triggerConfig: preset.triggerConfig,
            action: preset.action,
            actionConfig: preset.actionConfig,
            // Always start disabled + dry-run; operator flips both
            // after reviewing.
            enabled: false,
          }),
        },
      )
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errBody.error ?? `Apply failed (${res.status})`)
      }
      toast.success(
        preset.needsEdit
          ? t('automation.presets.appliedNeedsEdit', { name: preset.name })
          : t('automation.presets.applied', { name: preset.name }),
      )
      onApplied()
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('automation.presets.applyError'),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return
        onClose()
      }}
      title={t('automation.presets.title')}
      size="2xl"
    >
      <ModalBody>
        <div className="space-y-3">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('automation.presets.intro')}
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {RULE_PRESETS.map((preset) => {
              const Icon = CATEGORY_ICON[preset.category]
              return (
                <li
                  key={preset.id}
                  className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
                >
                  <div className="mb-1.5 flex items-start gap-1.5">
                    <Icon className="w-4 h-4 mt-0.5 flex-shrink-0 text-slate-400" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {preset.name}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {preset.description}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {preset.requiresAi && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                        <Sparkles className="w-2.5 h-2.5" />
                        AI
                      </span>
                    )}
                    {preset.needsEdit && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-blue-800 dark:bg-blue-500/20 dark:text-blue-300">
                        <AlertTriangle className="w-2.5 h-2.5" />
                        {t('automation.presets.needsEditBadge')}
                      </span>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => apply(preset)}
                      disabled={busy !== null}
                      className="ml-auto"
                    >
                      {busy === preset.id ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : null}
                      {t('automation.presets.applyCta')}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
          {t('common.close')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
