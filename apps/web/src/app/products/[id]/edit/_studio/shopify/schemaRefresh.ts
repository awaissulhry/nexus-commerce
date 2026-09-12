/** Coalesce refresh hints, but replay a hint received during a read before accepting the schema. */
export function createSchemaRefresh<T>(load: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, fail: (error: unknown) => void) {
  const controller = new AbortController()
  let running: Promise<void> | null = null, queued = false
  return {
    refresh(): Promise<void> {
      if (controller.signal.aborted) return Promise.resolve()
      if (running) { queued = true; return running }
      running = (async () => {
        do {
          queued = false
          try {
            const value = await load(controller.signal)
            if (!controller.signal.aborted && !queued) accept(value)
          } catch (error) {
            if (!controller.signal.aborted && !queued) fail(error)
          }
        } while (queued && !controller.signal.aborted)
      })().finally(() => { running = null })
      return running
    },
    dispose() { controller.abort() },
  }
}
