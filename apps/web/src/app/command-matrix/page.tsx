import PageHeader from '@/components/layout/PageHeader'
import CommandMatrixClient from './CommandMatrixClient'

export const dynamic = 'force-dynamic'

export default function CommandMatrixPage() {
  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      <div className="flex-none px-4 pt-4 pb-2">
        <PageHeader
          title="Command Matrix"
          description="Hierarchical catalog · locale × channel status · inline edit"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden px-4 pb-4">
        <CommandMatrixClient />
      </div>
    </div>
  )
}
