import PageHeader from '@/components/layout/PageHeader'
import ReportDetailClient from './ReportDetailClient'
import { getReportDetail } from './actions'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ reportId: string }>
}

export default async function ReportDetailPage({ params }: PageProps) {
  const { reportId } = await params
  const result = await getReportDetail(reportId)

  const initialData = result.success && result.data
    ? result.data
    : {
        reportId,
        name: reportId,
        generatedAt: new Date().toISOString(),
        sections: [],
      }

  return (
    <div>
      <PageHeader
        title={initialData.name}
        subtitle={`Detailed report — ${reportId}`}
        breadcrumbs={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Reports', href: '/dashboard/reports' },
          { label: initialData.name },
        ]}
      />
      <ReportDetailClient initialData={initialData} />
    </div>
  )
}
