/**
 * The floor app version this web server serves now (B-W2a-42; PLT-241): `/floor/version` (the floor's own route, not the
 * API). Admin › Devices marks a tablet that reports another version as outdated. Null when it cannot be read: then
 * nothing is marked (never "outdated" by guess).
 */
export async function fetchFloorVersion(): Promise<string | null> {
  try {
    const answer = await fetch('/floor/version', { cache: 'no-store', credentials: 'same-origin' })
    if (!answer.ok) return null
    const body = (await answer.json()) as { version?: unknown }
    return typeof body.version === 'string' && body.version !== '' ? body.version : null
  } catch {
    return null
  }
}
