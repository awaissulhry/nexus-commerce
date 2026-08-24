import { UploadCloud } from 'lucide-react'
import { Button, FileDropzone } from '@nexus/design-system'

const Zone = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 420, maxWidth: '100%' }}>{children}</div>
)

/** Resting state. With no `hint`, the secondary line is built from `accept` + `maxBytes`. */
export const Resting = () => (
  <Zone>
    <FileDropzone accept=".xlsx" maxBytes={50 * 1024 * 1024} onFiles={() => {}} />
  </Zone>
)

/** The flat-file import: several spreadsheet formats, `multiple`, and a custom `hint` node. */
export const CustomHint = () => (
  <Zone>
    <FileDropzone
      accept=".csv,.tsv,.xlsx,.xls,.json"
      maxBytes={15 * 1024 * 1024}
      multiple
      onFiles={() => {}}
      hint={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <UploadCloud size={13} aria-hidden /> CSV, TSV, Excel or JSON · up to 15MB
        </span>
      }
    />
  </Zone>
)

/** `disabled` dims the zone and refuses both the click and the drop. */
export const Disabled = () => (
  <Zone>
    <FileDropzone accept=".xlsx" maxBytes={50 * 1024 * 1024} disabled onFiles={() => {}} />
  </Zone>
)

/** In place: the bulksheet upload card, with the escape hatch for operators who have no file yet. */
export const BulksheetUpload = () => (
  <div
    style={{
      width: 440,
      maxWidth: '100%',
      padding: 16,
      border: '1px solid var(--border-default)',
      borderRadius: 12,
      background: 'var(--surface-card)',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}
  >
    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Upload an edited bulksheet</div>
    <FileDropzone
      accept=".xlsx"
      maxBytes={50 * 1024 * 1024}
      onFiles={() => {}}
      hint="An .xlsx bulksheet, up to 50 MB. Leave Operation blank on any row you do not want to change."
    />
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Do not have one yet?</span>
      <Button size="sm">Download current data</Button>
    </div>
  </div>
)
