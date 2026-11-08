'use client'

import { useEffect, useState } from 'react'
import { Modal } from '../../../lib/i18n/ds-parts'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { EmailSettingsView, type EmailSettingsViewModel } from './EmailSettingsView'
import { DisplayView, MyAccessView, ShortcutsView, StillThereView, UnsavedGuardView, type DisplayModel, type MyAccessModel, type ShortcutGroup, type UnsavedModel } from './FrameDialogs'
import { NotificationsView, type NotificationsViewModel } from './NotificationsView'
import { PortalShellView, type PortalShellViewModel } from './PortalShellView'
import { RecordView, type RecordViewModel } from './RecordView'
import { SearchView, type SearchViewModel } from './SearchView'
import { TasksView, type TasksViewModel } from './TasksView'
import { TermsView, type TermsViewModel } from './TermsView'
import { ThreadView, type ThreadViewModel } from './ThreadView'

/**
 * SCR-027 as one case of the design review (B-W2b-173): the frame around one of its own pages (Home's task list, a record
 * with its Messages, the portal terms) and, when the case asks, one of its pop-ups open. The live frame composes the same
 * views (PortalShell); this only puts a case's made-up models together.
 */

export type PortalFramePage = { kind: 'home'; tasks: TasksViewModel } | { kind: 'record'; record: RecordViewModel; thread: ThreadViewModel } | { kind: 'terms'; terms: TermsViewModel }

export type PortalFramePopup =
  | { kind: 'notifications'; model: NotificationsViewModel }
  | { kind: 'email'; model: EmailSettingsViewModel }
  | { kind: 'still'; endsInMs: number; canStay: boolean }
  | { kind: 'shortcuts'; groups: readonly ShortcutGroup[] }
  | { kind: 'unsaved'; model: UnsavedModel }
  | { kind: 'access'; model: MyAccessModel }
  | { kind: 'display'; model: DisplayModel }
  | { kind: 'search'; model: SearchViewModel }
  | { kind: 'ask'; thread: ThreadViewModel }

export interface PortalFrameCaseModel {
  shell: PortalShellViewModel
  page: PortalFramePage
  popup?: PortalFramePopup | null
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type PortalFrameCaseBuilder = (locale: Locale) => PortalFrameCaseModel

export function PortalFrameCase({ model: build }: { model: PortalFrameCaseBuilder }) {
  const t = useT('portal')
  const model = build(useLocale())
  const [endsAt, setEndsAt] = useState<string | null>(null)
  // The countdown runs from the moment the case opens (the model is rebuilt on every render: depend on the number).
  const endsInMs = model.popup?.kind === 'still' ? model.popup.endsInMs : null
  useEffect(() => {
    if (endsInMs !== null) setEndsAt(new Date(Date.now() + endsInMs).toISOString())
  }, [endsInMs])
  const popup = model.popup ?? null
  const close = () => undefined
  return (
    <>
      <PortalShellView model={model.shell}>
        {model.page.kind === 'home' ? (
          <TasksView model={model.page.tasks} />
        ) : model.page.kind === 'record' ? (
          <RecordView model={model.page.record}>
            <ThreadView model={model.page.thread} />
          </RecordView>
        ) : (
          <TermsView model={model.page.terms} />
        )}
      </PortalShellView>
      {popup?.kind === 'notifications' ? <NotificationsView model={popup.model} onClose={close} onMarkAll={close} onRetry={close} /> : null}
      {popup?.kind === 'email' ? <EmailSettingsView model={popup.model} onClose={close} onRetry={close} /> : null}
      {popup?.kind === 'still' && endsAt ? <StillThereView model={{ open: true, endsAt, canStay: popup.canStay }} /> : null}
      {popup?.kind === 'shortcuts' ? <ShortcutsView open groups={popup.groups} onClose={close} /> : null}
      {popup?.kind === 'unsaved' ? <UnsavedGuardView model={popup.model} onStay={close} /> : null}
      {popup?.kind === 'access' ? <MyAccessView model={popup.model} onClose={close} onRetry={close} /> : null}
      {popup?.kind === 'display' ? <DisplayView model={popup.model} onClose={close} /> : null}
      {popup?.kind === 'search' ? <SearchView model={popup.model} onClose={close} onRetry={close} /> : null}
      {popup?.kind === 'ask' ? (
        <Modal open onClose={close} sheet size="lg" title={t('thread.accountTitle')}>
          <ThreadView model={popup.thread} headingLevel={3} />
        </Modal>
      ) : null}
    </>
  )
}
