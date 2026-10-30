import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'

/**
 * The tablet tells the office about itself (B-W2a-42; PLT-241; design admin.devices "App version", "Battery", the Status
 * tab's "actions waiting to sync"): the floor app's version this page runs, the battery when the browser says it
 * (Chromium's Battery Status API; null elsewhere), and how many actions wait in its offline queue — a count of the
 * device's queue, never whose. `POST /floor/device/state` (the device token and CSRF, signed in or not).
 *
 * Sent at start, then at most every REPORT_EVERY_MS, and at once when the app version changes or the queue empties or
 * starts to fill (what the office's Devices page shows). A failed report is tried at the next tick; it never blocks
 * the floor.
 */

export const REPORT_EVERY_MS = 5 * 60_000

export interface DeviceState {
  readonly appVersion: string
  readonly batteryPercent: number | null
  readonly batteryCharging: boolean | null
  readonly queuedActions: number
}

export interface LastReport {
  readonly at: number
  readonly state: DeviceState
}

/** Whether a report is due now. */
export function reportDue(last: LastReport | null, next: DeviceState, now: number): boolean {
  if (!last) return true
  if (last.state.appVersion !== next.appVersion) return true
  if ((last.state.queuedActions === 0) !== (next.queuedActions === 0)) return true
  return now - last.at >= REPORT_EVERY_MS
}

interface BatteryManager {
  readonly level: number
  readonly charging: boolean
}

/** The battery, where the browser says it (Chrome on Android does; Safari and Firefox do not): percent and charging. */
export async function readBattery(): Promise<{ percent: number | null; charging: boolean | null }> {
  try {
    const getBattery = (globalThis.navigator as (Navigator & { getBattery?: () => Promise<BatteryManager> }) | undefined)?.getBattery
    if (typeof getBattery !== 'function') return { percent: null, charging: null }
    const battery = await getBattery.call(globalThis.navigator)
    const percent = Math.round(battery.level * 100)
    return { percent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null, charging: typeof battery.charging === 'boolean' ? battery.charging : null }
  } catch {
    return { percent: null, charging: null }
  }
}

const answer = z.object({ reportedAt: z.string(), appUpdated: z.boolean() })

export async function sendDeviceState(api: ApiClient, state: DeviceState): Promise<z.infer<typeof answer>> {
  await api.get('/auth/csrf')
  return api.post('/floor/device/state', { body: state, schema: answer })
}

/** Keeps the last report and sends the next when it is due. */
export class DeviceReporter {
  private last: LastReport | null = null
  private flight: Promise<void> | null = null

  constructor(
    private readonly send: (state: DeviceState) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sends `state` if due (one at a time); a failure is tried again at the next call. */
  async report(state: DeviceState): Promise<boolean> {
    if (this.flight || !reportDue(this.last, state, this.now())) return false
    let sent = false
    this.flight = (async () => {
      try {
        await this.send(state)
        this.last = { at: this.now(), state }
        sent = true
      } catch {
        // The next tick tries again.
      }
    })()
    await this.flight
    this.flight = null
    return sent
  }
}
