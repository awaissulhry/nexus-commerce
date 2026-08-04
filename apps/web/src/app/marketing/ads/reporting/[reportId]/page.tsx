import { ReportRunner } from '../ReportRunner'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params
  return <ReportRunner reportId={reportId} />
}
