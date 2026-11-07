import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'

/**
 * What the files panel in depth asks of its container (use-file-depth.ts; B-W2b-177). In the design index none is
 * passed: the parts draw and nothing is sent.
 */
export interface FileDepthActions {
  onRetryDocuments?: () => void
  onDismissNotice?: () => void
  /** The Versions pop-up of a file's series (Files row › Versions). */
  onOpenVersions?: (fileId: string) => void
  onCloseVersions?: () => void
  onRetryVersions?: () => void
  /** Tick a version for side by side (at most two). */
  onPickVersion?: (fileId: string, picked: boolean) => void
  onCompare?: () => void
  onCloseCompare?: () => void
  onPreviewVersion?: (fileId: string) => void
  onRestore?: (fileId: string) => void
  /** What the file is and until when (its document type and expiry date). */
  onOpenTag?: (fileId: string) => void
  onTagDraft?: (change: { category?: string | null; expiresOn?: string }) => void
  onSaveTag?: () => void
  onCloseTag?: () => void
  /** Mark up a picture or a PDF page. */
  onOpenMarkup?: (fileId: string) => void
  onMarkupPage?: (page: number) => void
  onMarkupNote?: (note: string) => void
  /** Save the marks (a picture: its marked copy as the next version; a PDF page: an overlay). */
  onSaveMarkup?: (photo: CapturedPhoto) => Promise<void>
  onCloseMarkup?: () => void
}
