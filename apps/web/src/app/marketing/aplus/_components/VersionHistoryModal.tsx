'use client'

// MC.8.10 — version history modal.
//
// Lists APlusContentVersion rows for the document. Each row shows
// version number, reason (pre_submit / manual_save / pre_rollback),
// and timestamp. Operator can:
//   - Save current as a manual snapshot
//   - Restore to any historical version (creates a pre_rollback
//     snapshot first so the rollback itself is undoable)

import { useEffect, useState } from 'react'
import {
  History,
  RotateCcw,
  Save,
  Loader2,
  Send,
  RefreshCw,
} from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'

interface VersionRow {
  id: string
  version: number
  reason: 'pre_submit' | 'manual_save' | 'pre_rollback' | string
  createdAt: string
}

interface Props {
  open: boolean
  onClose: () => void
  contentId: string
  apiBase: string
  onRestored: () => void
}

const REASON_LABEL: Record<string, string> = {
  pre_submit: 'Before Amazon submission',
  manual_save: 'Manual save',
  pre_rollback: 'Before rollback',
}

const REASON_ICON: Record<string, typeof Send> = {
  pre_submit: Send,
  manual_save: Save,
  pre_rollback: RotateCcw,
}

export default function VersionHistoryModal({
  open,
  onClose,
  contentId,
  apiBase,
  onRestored,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${apiBase}/api/aplus-content/${encodeURIComponent(contentId)}/versions`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`Versions API returned ${res.status}`)
      const data = (await res.json()) as { versions: VersionRow[] }
      setVersions(data.versions)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('aplus.versions.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contentId])

  const saveCurrent = async () => {
    setBusy('save')
    try {
      const res = await fetch(
        `${apiBase}/api/aplus-content/${encodeURIComponent(contentId)}/versions/save`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      const data = (await res.json()) as { version: number }
      toast.success(t('aplus.versions.saved', { n: data.version.toString() }))
      await load()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('aplus.versions.saveError'),
      )
    } finally {
      setBusy(null)
    }
  }

  const restore = async (version: VersionRow) => {
    const ok = await confirm({
      title: t('aplus.versions.restoreTitle', {
        n: version.version.toString(),
      }),
      description: t('aplus.versions.restoreBody'),
      confirmLabel: t('aplus.versions.restoreCta'),
      tone: 'warning',
    })
    if (!ok) return
    setBusy(`restore-${version.id}`)
    try {
      const res = await fetch(
        `${apiBase}/api/aplus-content/${encodeURIComponent(contentId)}/versions/${encodeURIComponent(version.id)}/restore`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(`Restore failed (${res.status})`)
      toast.success(
        t('aplus.versions.restored', { n: version.version.toString() }),
      )
      await load()
      onRestored()
      onClose()
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('aplus.versions.restoreError'),
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
      title={t('aplus.versions.title')}
      size="lg"
    >
      <ModalBody>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('aplus.versions.intro')}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={load}
                disabled={loading}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={saveCurrent}
                disabled={busy !== null}
              >
                {busy === 'save' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5 mr-1" />
                )}
                {t('aplus.versions.saveCurrent')}
              </Button>
            </div>
          </div>

          {loading && versions.length === 0 ? (
            <div className="flex items-center justify-center gap-1.5 py-6 text-xs text-slate-500 dark:text-slate-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t('aplus.versions.loading')}
            </div>
          ) : versions.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs italic text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
              {t('aplus.versions.empty')}
            </p>
          ) : (
            <ol className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
              {versions.map((v) => {
                const Icon = REASON_ICON[v.reason] ?? History
                const label = REASON_LABEL[v.reason] ?? v.reason
                return (
                  <li
                    key={v.id}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    <Icon className="w-4 h-4 flex-shrink-0 text-slate-400" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        v{v.version}{' '}
                        <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">
                          {label}
                        </span>
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {new Date(v.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => restore(v)}
                      disabled={busy !== null}
                    >
                      {busy === `restore-${v.id}` ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5" />
                      )}
                      <span className="ml-1">
                        {t('aplus.versions.restoreShort')}
                      </span>
                    </Button>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose} disabled={busy !== null}>
          {t('common.close')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
