'use client'

/**
 * FileRow — the ONE file an operator picked, shown before and while it is processed. The sibling
 * of `FileDropzone`: the dropzone takes the file, this row stands in its place once there is one.
 * One compact row: a file-type icon, the name (truncated, the whole name in `title`) with its size,
 * a short status line, then the sm (28px) actions — "Replace file" and a named × to remove it.
 * `tone="danger"` marks a file that was refused; the status line says why (colour is never the
 * only signal). Requires `styles/components.css`.
 *
 * `actions` (B-W2b-09, the FileRow actions slot): the app's own sm buttons or links for a file that
 * is already stored — Download, Open in the viewer, Print, a ⋯ menu — drawn first in the same
 * cluster, before Replace and Remove. Give each a name that says which file it acts on (or
 * `aria-describedby` the row's name). With them the row may wrap: the cluster moves under the name when the row is too
 * narrow (`has-actions`; a row without app actions keeps its one line). `labels` translates the row's own two actions.
 */
import { useId, type ReactNode } from 'react'
import { File as FileIcon, FileArchive, FileSpreadsheet, FileText, X } from 'lucide-react'
import { Button } from '../primitives/Button'
import { ToolbarButton } from '../primitives/ToolbarButton'
import { formatBytes } from '../lib/format'
import { mergeLabels } from '../lib/labels'
import { FILE_ROW_LABELS, type FileRowLabels } from './FileRowLabels'

export interface FileRowProps {
  /** The file's name as picked. Truncated in the row; the whole name is the `title`. */
  name: string
  /** Size in bytes, shown as "673 KB". */
  size?: number
  /** Short line under the name — "Reading… 3 s", "Nexus file · 42 products", or why a file was refused. */
  status?: ReactNode
  /** `danger` = the file was refused: the border, icon and status line take the danger role. */
  tone?: 'neutral' | 'danger'
  /** Shows a ghost "Replace file" button. */
  onReplace?: () => void
  /** Shows a × icon button named "Remove file". */
  onRemove?: () => void
  /** Locks both actions (e.g. while the file is being read). */
  disabled?: boolean
  className?: string
  /**
   * The app's own actions for this file (Download, Open, Print, a ⋯ menu), drawn before Replace and Remove. sm (28px)
   * controls; `disabled` does not lock them (the app holds its own with `heldReason`).
   */
  actions?: ReactNode
  /** The row's own words ("Replace file", "Remove file"); English by default. */
  labels?: Partial<FileRowLabels>
}

const SPREADSHEET = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i
const ARCHIVE = /\.(zip|gz|7z)$/i
const TEXT = /\.(txt|json|xml)$/i

function TypeIcon({ name }: { name: string }) {
  const Icon = SPREADSHEET.test(name) ? FileSpreadsheet : ARCHIVE.test(name) ? FileArchive : TEXT.test(name) ? FileText : FileIcon
  return <Icon size={16} aria-hidden />
}

export function FileRow({ name, size, status, tone = 'neutral', onReplace, onRemove, disabled = false, className, actions, labels }: FileRowProps) {
  const words = mergeLabels(FILE_ROW_LABELS, labels)
  const hasActions = actions != null && actions !== false && actions !== ''
  const nameId = useId()
  const cls = ['nds-filerow', tone === 'danger' ? 'danger' : '', hasActions ? 'has-actions' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      <span className="nds-filerow-icon"><TypeIcon name={name} /></span>
      <div className="nds-filerow-body">
        <div className="nds-filerow-line">
          <span id={nameId} className="nds-filerow-name" title={name}>{name}</span>
          {size != null && <span className="nds-filerow-size">{formatBytes(size)}</span>}
        </div>
        {status != null && status !== '' && <div className="nds-filerow-status">{status}</div>}
      </div>
      {(hasActions || onReplace || onRemove) && (
        <div className="nds-filerow-actions">
          {hasActions && actions}
          {onReplace && (
            <Button variant="ghost" size="sm" onClick={onReplace} disabled={disabled} aria-describedby={nameId}>
              {words.replace}
            </Button>
          )}
          {onRemove && (
            <ToolbarButton icon={<X size={15} aria-hidden />} label={words.remove} tooltip={false} onClick={onRemove}
              disabled={disabled} aria-describedby={nameId} />
          )}
        </div>
      )}
    </div>
  )
}
