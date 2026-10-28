'use client'

/**
 * FileRow — the ONE file an operator picked, shown before and while it is processed. The sibling
 * of `FileDropzone`: the dropzone takes the file, this row stands in its place once there is one.
 * One compact row: a file-type icon, the name (truncated, the whole name in `title`) with its size,
 * a short status line, then the sm (28px) actions — "Replace file" and a named × to remove it.
 * `tone="danger"` marks a file that was refused; the status line says why (colour is never the
 * only signal). Requires `styles/components.css`.
 */
import { useId, type ReactNode } from 'react'
import { File as FileIcon, FileArchive, FileSpreadsheet, FileText, X } from 'lucide-react'
import { Button } from '../primitives/Button'
import { ToolbarButton } from '../primitives/ToolbarButton'
import { formatBytes } from '../lib/format'

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
}

const SPREADSHEET = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i
const ARCHIVE = /\.(zip|gz|7z)$/i
const TEXT = /\.(txt|json|xml)$/i

function TypeIcon({ name }: { name: string }) {
  const Icon = SPREADSHEET.test(name) ? FileSpreadsheet : ARCHIVE.test(name) ? FileArchive : TEXT.test(name) ? FileText : FileIcon
  return <Icon size={16} aria-hidden />
}

export function FileRow({ name, size, status, tone = 'neutral', onReplace, onRemove, disabled = false, className }: FileRowProps) {
  const nameId = useId()
  const cls = ['nds-filerow', tone === 'danger' ? 'danger' : '', className ?? ''].filter(Boolean).join(' ')
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
      {(onReplace || onRemove) && (
        <div className="nds-filerow-actions">
          {onReplace && (
            <Button variant="ghost" size="sm" onClick={onReplace} disabled={disabled} aria-describedby={nameId}>
              Replace file
            </Button>
          )}
          {onRemove && (
            <ToolbarButton icon={<X size={15} aria-hidden />} label="Remove file" tooltip={false} onClick={onRemove}
              disabled={disabled} aria-describedby={nameId} />
          )}
        </div>
      )}
    </div>
  )
}
