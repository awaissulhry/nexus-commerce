'use client'

import { useState } from 'react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { LibrarySettings } from '../api'
import { librarySettingsHeld, settingDraftOf, settingsSaveHeld, type SettingDraft, type SettingsActions, type SettingsModel } from '../model'
import { SettingsEditor, SettingsList } from './SettingsEditor'
import { useLocale } from '../../../../../lib/i18n/provider'
import '../depth.css'

/**
 * Operation › Machine & settings (B-W2b-235; design products.operations rec:Operation tab operation.machine, PRD-118): the
 * library operation's default machine and stitch settings — what a routing step copies ("Copy from library") and the
 * tablet shows beside the instruction. An explicit save (EditModeBar, ⌘S) at the operation's version; read only, drawn as
 * text with why, for a role without product.operations.manage or an archived operation. It fetches nothing.
 */
export function MachineSettingsTab({ model, actions }: { model: SettingsModel; actions?: SettingsActions }) {
  return (
    <WithMessages namespaces={['products-operations-depth']}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: SettingsModel; actions?: SettingsActions }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  const part = model.part
  if (part.status === 'error')
    return (
      <Banner tone="danger" title={t('settings.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{tl('common.retry')}</Button>}>
        {tl(part.problem)}
      </Banner>
    )
  if (part.status !== 'ready')
    return (
      <Card header={t('settings.title')} aria-busy="true">
        <p className="fw-opd-hint" role="status">
          <Spinner size={14} /> {t('settings.loading')}
        </p>
        <div className="fw-opd-stack">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  return <Ready key={`${part.value.operation.id}-${part.value.operation.version}`} view={part.value} model={model} actions={actions} />
}

function Ready({ view, model, actions }: { view: LibrarySettings; model: SettingsModel; actions?: SettingsActions }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  const locale = useLocale()
  const base = view.settings.map((setting) => settingDraftOf(setting, locale))
  const [drafts, setDrafts] = useState<SettingDraft[]>(model.drafts ?? base)
  const [tried, setTried] = useState(!!model.drafts)
  const held = librarySettingsHeld(view)
  const saveHeld = settingsSaveHeld(drafts, view.settings, model.busy)
  const dirty = settingsSaveHeld(drafts, view.settings, false) !== 'settings.held.same'
  const save = () => {
    setTried(true)
    if (saveHeld) return
    void actions?.onSave?.(drafts)
  }
  const notice = model.notice
  return (
    <div className="fw-opd-stack-lg">
      {notice && (
        <Banner
          tone={notice.tone}
          title={notice.key.startsWith('problem.') ? tl(notice.key, notice.params) : t(notice.key, notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {tl('common.dismiss')}
            </Button>
          }
        >
          {model.refused && model.refused.messages.length > 0 && (
            <ul className="fw-opd-list">
              {model.refused.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      {held && <Banner tone="info" title={t(held)} />}
      <Card header={t('settings.title')} description={t('settings.intro')}>
        {held ? (
          <SettingsList settings={view.settings} />
        ) : (
          <div className="fw-opd-stack">
            <SettingsEditor drafts={drafts} onDrafts={setDrafts} classes={model.classes} current={view.settings} shown={tried} idPrefix="op" />
            {dirty && (
              <EditModeBar
                count={1}
                message={t('settings.unsaved')}
                onDiscard={() => {
                  setDrafts(base)
                  setTried(false)
                }}
                onApply={save}
                applyLabel={t('settings.save')}
                applyHeldReason={model.offline ? t('offline.held') : saveHeld && saveHeld !== 'held.busy' ? t(saveHeld) : null}
                busy={model.busy}
                saveShortcut
              />
            )}
          </div>
        )}
      </Card>
      <Card header={t('settings.whereTitle')}>
        <ul className="fw-opd-list">
          <li>{t('settings.where.copy')}</li>
          <li>{t('settings.where.tablet')}</li>
          <li>{view.draftStepsWithout > 0 ? t('settings.where.without', { count: view.draftStepsWithout }) : t('settings.where.allOwn')}</li>
        </ul>
      </Card>
    </div>
  )
}
