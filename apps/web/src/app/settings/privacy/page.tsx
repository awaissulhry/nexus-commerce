import { getBackendUrl } from '@/lib/backend-url'
import PrivacyClient, {
  type ExportRow,
  type RetentionState,
  type ConsentLatest,
} from './PrivacyClient'

export const dynamic = 'force-dynamic'

export default async function PrivacyPage() {
  const backend = getBackendUrl()
  let exports: ExportRow[] = []
  let retention: RetentionState | null = null
  let consent: ConsentLatest = {}
  let loadError: string | null = null

  try {
    const [exportsRes, retentionRes, consentRes] = await Promise.all([
      fetch(`${backend}/api/settings/privacy/exports`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/privacy/retention`, { cache: 'no-store' }),
      fetch(`${backend}/api/settings/privacy/consent`, { cache: 'no-store' }),
    ])
    if (exportsRes.ok) exports = (await exportsRes.json()).exports ?? []
    if (retentionRes.ok) retention = await retentionRes.json()
    if (consentRes.ok) consent = (await consentRes.json()).latest ?? {}
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return (
    <PrivacyClient
      initialExports={exports}
      initialRetention={retention}
      initialConsent={consent}
      initialError={loadError}
    />
  )
}
