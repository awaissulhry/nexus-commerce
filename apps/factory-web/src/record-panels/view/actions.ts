import type { ComposerDraft, FileAudience, FileKind, PanelTab, ThreadStatus, TimelineFilter } from '../model'
import type { TaskDraft } from '../tasks/model'

/**
 * What the record panels ask of their page (RecordPanels.tsx does each through the API). In the design index none is
 * passed: the panels still switch tabs and take typing, and nothing is sent.
 */
export interface RecordPanelsActions {
  onTab?: (tab: PanelTab) => void
  /** Send the composer's draft; resolves true when it went (the composer then empties). */
  onSend?: (draft: ComposerDraft) => Promise<boolean>
  onThreadStatus?: (status: ThreadStatus) => void
  onMoreMessages?: () => void
  onUpload?: (file: File, choice: { kind: FileKind; visibility: FileAudience[] }) => void
  onDismissUpload?: (key: string) => void
  onDownload?: (fileId: string) => void
  onPreview?: (fileId: string) => void
  onClosePreview?: () => void
  onTimelineFilter?: (filter: TimelineFilter) => void
  onMoreTimeline?: () => void
  onRetry?: (part: 'thread' | 'files' | 'timeline' | 'tasks' | 'followers') => void
  onDismissNotice?: () => void
  /** B-W2a-40 — tasks on the record: tick one done (Undo puts it back), open / close the New task dialog, make one. */
  onCompleteTask?: (taskId: string) => void
  onUndoTask?: () => void
  onTaskDialog?: (open: boolean) => void
  onRetryAssignees?: () => void
  /** Resolves true when the task was made (the dialog then closes). */
  onCreateTask?: (draft: TaskDraft) => Promise<boolean>
  /** Followers: my own follow (follow, unfollow, mute), a colleague added. */
  onFollow?: (wanted: { following: boolean; muted: boolean }) => void
  onAddFollower?: (userId: string) => void
}
