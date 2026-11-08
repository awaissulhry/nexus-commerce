'use client'

import { usePortalTasks } from '../PortalShell'
import { TasksView } from '../view/TasksView'

/**
 * The portal's Home as the frame draws it (B-W2b-173): "What waits for you", the one task list (COL-043). The Home steps
 * (B-W2b-187 customer, B-W2b-179 supplier) put their tiles, deliveries and messages around the same list
 * (`usePortalTasks()` + `TasksView`), in `app/(portal)/p/[party]/page.tsx` by the person's kind.
 */
export function PortalHome() {
  const tasks = usePortalTasks()
  return <TasksView model={tasks.model} onDone={tasks.onDone} onUndo={tasks.onUndo} onRetry={tasks.onRetry} />
}
