import TimingDefaultsClient from './TimingDefaultsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ReviewTimingDefaultsPage() {
  return <TimingDefaultsClient />
}
