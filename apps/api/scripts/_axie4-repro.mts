import { validateBulksheetStreaming } from '../src/services/advertising/bulksheet/import-validate.js'
try {
  const r = await validateBulksheetStreaming(process.argv[2]!, async () => {})
  console.log('RESULT', JSON.stringify({ structural: r.structuralError, counts: r.counts, headers: r.headers }))
} catch (e) {
  console.log('THREW:', (e as Error).message)
  console.log((e as Error).stack?.split('\n').slice(0, 8).join('\n'))
}
