/** Serialise changes within a product; refresh only after the whole paste/fill has settled. */
export function createFormulaSaveQueue(onSettled: () => void) {
  const tails = new Map<string, Promise<unknown>>()
  let pending = 0
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Count a save that something else orders (a sheet's write line): the refresh still waits for it. */
  const track = <T>(task: Promise<T>): Promise<T> => {
    clearTimeout(timer)
    pending += 1
    return task.finally(() => {
      pending -= 1
      if (active && pending === 0) timer = setTimeout(onSettled, 100)
    })
  }
  return {
    enqueue<T>(rowId: string, action: () => Promise<T>): Promise<T> {
      const task = (tails.get(rowId) ?? Promise.resolve()).catch(() => {}).then(action)
      tails.set(rowId, task)
      return track(task.finally(() => { if (tails.get(rowId) === task) tails.delete(rowId) }))
    },
    track,
    activate() { active = true },
    dispose() { active = false; clearTimeout(timer) },
  }
}
