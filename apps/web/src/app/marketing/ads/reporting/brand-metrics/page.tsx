import { ReportRunner } from '../ReportRunner'

// Brand Metrics keeps its own route because it is a rail child, but it is the
// same runner as every other report — no second implementation to drift.
export const dynamic = 'force-dynamic'

export default function Page() {
  return <ReportRunner reportId="brand-metrics" />
}
