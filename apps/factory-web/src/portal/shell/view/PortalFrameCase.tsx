'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale } from '../../../lib/i18n/provider'
// B-TH-273: a record page's body with its conversation docked (the portal record frame), drawn at a chosen width.
import { PortalRecordFrame } from '../record/PortalRecordFrame'
import type { PortalFrameMode } from '../record/model'
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
 * SCR-027 as one case of the design review (B-W2b-173): the frame around one of its own pages (Home's task list, the generic
 * record page with its summary and conversation (B-TH-274), the record-page rule with the docked conversation (B-TH-273), the
 * portal terms) and, when the case asks, one of its pop-ups open. The live frame composes the same
 * views (PortalShell); this only puts a case's made-up models together.
 */

export type PortalFramePage =
  | { kind: 'home'; tasks: TasksViewModel }
  | { kind: 'record'; record: RecordViewModel; thread: ThreadViewModel }
  | { kind: 'terms'; terms: TermsViewModel }
  // ---- B-TH-273: the rule every portal record page follows — its body, the conversation docked from 1280 px or behind "Messages
  // (2 new)" below (`mode`), the narrow page's full-width view open (`viewOpen`).
  | { kind: 'frame'; body: ReactNode; thread: ThreadViewModel | null; threadLabel: string; mode: PortalFrameMode; viewOpen?: boolean; newCount?: number }

export type PortalFramePopup =
  | { kind: 'notifications'; model: NotificationsViewModel }
  | { kind: 'email'; model: EmailSettingsViewModel }
  | { kind: 'still'; endsInMs: number; canStay: boolean }
  | { kind: 'shortcuts'; groups: readonly ShortcutGroup[] }
  | { kind: 'unsaved'; model: UnsavedModel }
  | { kind: 'access'; model: MyAccessModel }
  | { kind: 'display'; model: DisplayModel }
  | { kind: 'search'; model: SearchViewModel }

export interface PortalFrameCaseModel {
  shell: PortalShellViewModel
  page: PortalFramePage
  popup?: PortalFramePopup | null
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type PortalFrameCaseBuilder = (locale: Locale) => PortalFrameCaseModel

export function PortalFrameCase({ model: build }: { model: PortalFrameCaseBuilder }) {
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
        ) : model.page.kind === 'frame' ? (
          <PortalRecordFrame thread={model.page.thread ? <ThreadView model={model.page.thread} /> : null} threadLabel={model.page.threadLabel} design={{ mode: model.page.mode, viewOpen: model.page.viewOpen, newCount: model.page.newCount }}>
            {model.page.body}
          </PortalRecordFrame>
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
    </>
  )
}
