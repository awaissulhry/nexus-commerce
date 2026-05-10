'use client'

// MC.8.7 — A+ Content template picker.
//
// Lists curated templates grouped by category. Operator picks one,
// chooses append vs replace-existing, and the modules POST in bulk
// to /apply-template. Useful when the operator just created a draft
// and wants a reasonable starting point instead of an empty canvas.

import { useMemo, useState } from 'react'
import { Sparkles, Layers, Loader2, AlertTriangle } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  TEMPLATES,
  type AplusTemplate,
} from '../_lib/templates'

interface Props {
  open: boolean
  onClose: () => void
  contentId: string
  apiBase: string
  hasExistingModules: boolean
  onApplied: () => void
}

export default function TemplatePicker({
  open,
  onClose,
  contentId,
  apiBase,
  hasExistingModules,
  onApplied,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)

  const grouped = useMemo(() => {
    const map = new Map<string, AplusTemplate[]>()
    for (const tpl of TEMPLATES) {
      const list = map.get(tpl.category)
      if (list) list.push(tpl)
      else map.set(tpl.category, [tpl])
    }
    return [...map.entries()]
  }, [])

  const selected = TEMPLATES.find((tpl) => tpl.id === selectedId) ?? null

  const apply = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const res = await fetch(
        `${apiBase}/api/aplus-content/${encodeURIComponent(contentId)}/apply-template`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            modules: selected.modules,
            replaceExisting: replace,
          }),
        },
      )
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error ?? `Apply failed (${res.status})`)
      }
      toast.success(
        t('aplus.templates.applied', {
          n: selected.modules.length.toString(),
          label: selected.label,
        }),
      )
      onApplied()
      onClose()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('aplus.templates.applyError'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return
        onClose()
      }}
      title={t('aplus.templates.title')}
      size="2xl"
    >
      <ModalBody>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-2">
            {grouped.map(([category, list]) => (
              <section key={category} className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {category}
                </h3>
                <ul className="space-y-1.5">
                  {list.map((tpl) => (
                    <li key={tpl.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(tpl.id)}
                        className={`flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors ${
                          selectedId === tpl.id
                            ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40'
                            : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                        }`}
                      >
                        <Sparkles className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                            {tpl.label}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            {tpl.description}
                          </p>
                          <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-400">
                            <Layers className="w-3 h-3" />
                            {tpl.modules.length}{' '}
                            {t('aplus.templates.modules')}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <aside className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
            {selected ? (
              <>
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {selected.label}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {selected.description}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {t('aplus.templates.modulesIncluded')}
                  </p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-slate-700 dark:text-slate-300">
                    {selected.modules.map((m, idx) => (
                      <li key={idx} className="font-mono text-[11px]">
                        {m.type}
                      </li>
                    ))}
                  </ol>
                </div>
                {hasExistingModules && (
                  <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-900/20">
                    <input
                      type="checkbox"
                      checked={replace}
                      onChange={(e) => setReplace(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-amber-900 dark:text-amber-200">
                      <span className="flex items-center gap-1 font-medium">
                        <AlertTriangle className="w-3 h-3" />
                        {t('aplus.templates.replaceLabel')}
                      </span>
                      <span className="text-[11px] opacity-80">
                        {t('aplus.templates.replaceHint')}
                      </span>
                    </span>
                  </label>
                )}
              </>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t('aplus.templates.pickHint')}
              </p>
            )}
          </aside>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={apply}
          disabled={busy || !selected}
        >
          {busy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
          {t('aplus.templates.applyCta', {
            n: selected ? selected.modules.length.toString() : '0',
          })}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
