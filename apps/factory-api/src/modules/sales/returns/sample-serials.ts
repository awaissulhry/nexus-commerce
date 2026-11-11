import type { Issue } from '@nexus/factory-domain/core/errors'
import type { Reader } from './store'

/**
 * B-W2b-284 (W2b-5 wave 34: a SAMPLE work order's cell may name no order line): a serial typed on a return line that is a
 * garment of ours made for no order line — a sample of an internal or uncharged proto, fit or salesman round — was never sold,
 * so it does not come back on a return. Each such serial is refused in words at its line's `serial` path; any other serial (a
 * sold garment's, or one we do not know) is written as typed, as before. Office and portal returns plan their lines with it, so
 * the words name no work order (a customer reads them too).
 */
export async function sampleSerialProblems(db: Reader, typed: readonly { readonly serial: string | null | undefined; readonly path: string }[]): Promise<Issue[]> {
  const asked = typed.flatMap((entry) => {
    const serial = (entry.serial ?? '').trim()
    return serial === '' ? [] : [{ serial, path: entry.path }]
  })
  if (asked.length === 0) return []
  const forms = [...new Set(asked.flatMap((entry) => [entry.serial, entry.serial.toUpperCase()]))]
  const samples = await db.garmentSerial.findMany({ where: { serial: { in: forms }, workOrderSize: { salesOrderLineId: null } }, select: { serial: true } })
  if (samples.length === 0) return []
  const sample = new Set(samples.map((row) => row.serial.toUpperCase()))
  return asked.flatMap((entry) =>
    sample.has(entry.serial.toUpperCase()) ? [{ path: entry.path, message: `Serial ${entry.serial} is a sample made for no order: it was never sold, so it does not come back on a return.` }] : [],
  )
}
