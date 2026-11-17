import type { ApiFile } from '../../../../record-panels/api'
import type { PanelRead } from '../../../../record-panels/model'
import type { Assignable, TaskDraft, TaskItem } from '../../../../record-panels/tasks/model'
import type { ProjectPage } from '../api'
import type { Notice, Phrase, ProjectsCan } from '../model'
import type { CloseDraft, EditDraft } from './model'

/**
 * B-TH-249 — the project page's view model (SCR-701): what ProjectRecordView draws and what it asks its container to do. The view
 * fetches nothing; the People and Linked sections (B-TH-250, B-TH-251), the linked news and the thread come in as slots.
 */

/** A read of the page: being read, read, or failed (its problem a key of the shared catalogue: `problem.notFound` …). */
export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly data: T } | { readonly status: 'error'; readonly problem: string }

export type ProjectDialog =
  | { readonly kind: 'close'; readonly draft: CloseDraft; readonly busy: boolean; readonly problem: Phrase | null }
  | {
      readonly kind: 'edit'
      readonly draft: EditDraft
      /** Who may lead it: its office people and the colleagues who may read it. */
      readonly leads: Loaded<readonly { readonly id: string; readonly name: string }[]>
      readonly busy: boolean
      readonly problem: Phrase | null
      /** Someone changed the project first: Reload reads it again (the draft stays until then). */
      readonly stale: boolean
      /** The fields the API refused (`field.name` …). */
      readonly fields: readonly string[]
    }
  | { readonly kind: 'task'; readonly people: PanelRead<readonly Assignable[]>; readonly busy: boolean; readonly initial?: Partial<TaskDraft> }

export interface ProjectRecordModel {
  /** `/w/<company code>`. */
  readonly prefix: string
  /** The person reading (their own id). */
  readonly me: string | null
  readonly can: ProjectsCan
  readonly page: Loaded<ProjectPage>
  /** The page's own state: the network gone (writes held), a move or save running. */
  readonly offline: boolean
  readonly busy: boolean
  readonly notice: Notice | null
  /** The project's open tasks (null: the person does not see tasks — Home's tasks need home.view). */
  readonly tasks: PanelRead<readonly TaskItem[]> | null
  /** Why "Add task" is held (a key of `records`: no right) or null. */
  readonly addTaskHeld: string | null
  /** The project's files (null: the person may not read files, files.read). */
  readonly files: PanelRead<readonly ApiFile[]> | null
  readonly dialog: ProjectDialog | null
  /** Design cases only: the details view open (below 1280 px it replaces the thread). */
  readonly detailsOpen?: boolean
}

export interface ProjectRecordActions {
  onRetry?: () => void
  onEdit?: () => void
  onHold?: () => void
  onResume?: () => void
  onClose?: () => void
  onReopen?: () => void
  onCopyLink?: () => void
  onDismissNotice?: () => void
  /** The Close dialog. */
  close?: { onDraft: (patch: Partial<CloseDraft>) => void; onSubmit: () => void; onCancel: () => void }
  /** The Edit details dialog. */
  edit?: { onDraft: (patch: Partial<EditDraft>) => void; onSubmit: () => void; onReload: () => void; onRetryLeads: () => void; onCancel: () => void }
  /** Tasks: New task (the ONE dialog of the record panels), its people read again, its close. */
  task?: { onOpen: () => void; onCreate: (draft: TaskDraft) => Promise<boolean>; onRetryPeople: () => void; onCancel: () => void; onRetry: () => void }
  /** Files: open one (its download), read again. */
  files?: { onOpen: (fileId: string) => void; onRetry: () => void }
}
