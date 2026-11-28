import { useSyncExternalStore } from 'react'

/**
 * owb-fl8 step 4 — the phone's own floor settings (design § 5zf B "Me": Large words · Sound): kept in THIS device's storage only,
 * never sent (no server row, no queue kind: nothing records a person's setting). Wrapped like the order-change marks: a private
 * window or blocked storage keeps the setting for this visit. The floor frame reads them (FloorFrameView: `muted`, the large class).
 */

export interface FloorDeviceSettings {
  /** Larger words and buttons on every floor screen. */
  readonly large: boolean
  /** Sound and vibration of the confirm feedback. */
  readonly sound: boolean
}

export const SETTINGS_KEY = 'nexus.floor.settings'
export const DEFAULT_SETTINGS: FloorDeviceSettings = Object.freeze({ large: false, sound: true })

/** What the storage holds, read safely: anything unreadable is the default. */
export function readSettings(text: string | null): FloorDeviceSettings {
  if (!text) return DEFAULT_SETTINGS
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return { large: value.large === true, sound: value.sound !== false }
  } catch {
    return DEFAULT_SETTINGS
  }
}

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>

function deviceStorage(): SettingsStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

let current: FloorDeviceSettings | null = null
const listeners = new Set<() => void>()

/** The settings now (this visit's when the storage fails). */
export function floorSettings(storage: SettingsStorage | null = deviceStorage()): FloorDeviceSettings {
  if (current) return current
  let text: string | null = null
  try {
    text = storage?.getItem(SETTINGS_KEY) ?? null
  } catch {
    text = null
  }
  current = readSettings(text)
  return current
}

/** Change one setting: at once on every floor screen; kept in the storage when it can be. */
export function setFloorSetting<K extends keyof FloorDeviceSettings>(key: K, value: FloorDeviceSettings[K], storage: SettingsStorage | null = deviceStorage()): FloorDeviceSettings {
  current = { ...floorSettings(storage), [key]: value }
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(current))
  } catch {
    // Private window or blocked storage: the setting lives for this visit.
  }
  listeners.forEach((listener) => listener())
  return current
}

/** Tests only: forget what this visit read. */
export function resetFloorSettings(): void {
  current = null
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The settings, live (the frame and the Me page). */
export function useFloorDeviceSettings(): FloorDeviceSettings {
  return useSyncExternalStore(
    subscribe,
    () => floorSettings(),
    () => DEFAULT_SETTINGS,
  )
}
