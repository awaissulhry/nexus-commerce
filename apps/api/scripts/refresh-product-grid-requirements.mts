/** Refresh known missing category schemas only. Never creates listings or changes catalog values. */
import { writeFile } from 'node:fs/promises'
const apply = process.argv.includes('--apply')
const api = process.env.ATTRIBUTE_QA_API ?? 'http://localhost:8091'
const targets = ['BE', 'IE', 'PL', 'SE', 'TR'].map(marketplace => ({ channel: 'AMAZON', marketplace, productType: 'OUTERWEAR' }))
if (!apply) {
  console.log(JSON.stringify({ apply: false, targets, catalogValuesChanged: 0 }, null, 2))
} else {
  const results = []
  for (const target of targets) {
    try {
      const response = await fetch(`${api}/api/categories/schema?${new URLSearchParams({ ...target, force: '1', lite: '1' })}`, { signal: AbortSignal.timeout(90000) })
      const body = await response.json() as any
      const result = { ...target, status: response.status, schemaVersion: body.schemaVersion ?? null, fetchedAt: body.fetchedAt ?? null, error: body.error ?? body.message ?? null }
      results.push(result)
      console.log(JSON.stringify(result))
    } catch (error) {
      const result = { ...target, error: error instanceof Error ? error.message : String(error) }
      results.push(result)
      console.log(JSON.stringify(result))
    }
  }
  await writeFile('/tmp/nexus-master-first-schema-refresh.json', JSON.stringify({ generatedAt: new Date().toISOString(), results, catalogValuesChanged: 0 }, null, 2))
  if (results.some(result => !('status' in result) || result.status !== 200)) process.exitCode = 1
}
