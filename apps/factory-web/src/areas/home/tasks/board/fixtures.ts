import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as tasksScreen } from '../fixtures'
import type { TasksViewModel } from '../model'
import { TasksView } from '../view/TasksView'

/**
 * SCR-545 — Home › My tasks › Board by status and Calendar by due date (B-W2b-388; design home.tasks sec:tasks "Board by status and
 * Calendar by due date (W2b)"), on SCR-233's made-up tasks.
 */

const caseOf = (id: string): TasksViewModel => {
  const found = tasksScreen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`SCR-545: SCR-233 has no case ${id}`)
  return found.model
}

export const designScreen = defineDesignScreen<TasksViewModel>({
  screen: 'SCR-545',
  title: 'My tasks › Board and calendar (B-W2b-388)',
  view: TasksView,
  holdsPage: false,
  cases: [
    { id: 'board', label: 'Board by status', model: { ...caseOf('mine'), mode: 'board' }, note: 'Open · Done · Cancelled with their counts; a card goes Open → Done (done) and back (reopened); Cancelled is held with the reason (from the task itself). Overdue cards are marked.' },
    { id: 'calendar', label: 'Calendar by due date', model: { ...caseOf('mine'), mode: 'calendar' }, note: 'Each task on its due day, the chosen day’s tasks beside it, tasks without a day under it. It only reads.' },
    { id: 'board-read-only', label: 'Board, read only', model: { ...caseOf('read-only'), mode: 'board' }, note: 'Nothing moves; each card says why.' },
    { id: 'board-offline', label: 'Board offline', model: { ...caseOf('offline'), mode: 'board' }, note: 'Moves held: offline.' },
  ],
})
