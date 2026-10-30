import type { BusinessDate } from '../core/time'
import type { Phrase, WordParams } from './words'

/**
 * The words of Today's own rows (B-W2a-20; design home.today needs-me "tasks due or overdue · @mentions"): a task of mine
 * due today or overdue, a note that mentioned me. Phrases as insights/words makes them ({key, params, text}), from their
 * own templates: the web's catalogue (home.json `today.w.<key>`) gains these keys with the screens (B-W2a-40), and Today
 * sends these rows only to a screen that asks for them (`include`). Same param conventions: `count` picks the plural,
 * `…Date` is a business date.
 */
export const PERSONAL_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  'TASK_DUE.TODAY': 'Your task "{title}" is due today.',
  'TASK_DUE.TODAY_AT': 'Your task "{title}" is due today at {dueTime}.',
  'TASK_DUE.OVERDUE_one': 'Your task "{title}" is {count} day overdue: it was due on {dueDate}.',
  'TASK_DUE.OVERDUE_other': 'Your task "{title}" is {count} days overdue: it was due on {dueDate}.',
  'TASK_DUE.on': 'It is on {record}.',
  'MENTION.NOTE': '{actor} mentioned you in a note on {record}.',
  'why.TASK_DUE.assigned': 'It is assigned to you.',
  'why.MENTION.mentioned': 'You were mentioned.',
  // Coming up (insights/coming-up).
  'COMING.TASK': 'Your task "{title}" is due.',
  'COMING.ORDER': 'Order {number} for {customer} is promised.',
  'COMING.DELIVERY': '{supplier} should deliver purchase order {number}.',
  'COMING.CERTIFICATE': 'Certificate {number} expires.',
})

const dateWords = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value)

/** A phrase of these templates, in English (an unknown key throws, as insights/words does). */
export function personalPhrase(key: string, params: WordParams = {}): Phrase {
  const count = params.count
  const template = PERSONAL_TEMPLATES[key] ?? (typeof count === 'number' ? PERSONAL_TEMPLATES[`${key}_${count === 1 ? 'one' : 'other'}`] : undefined)
  if (template === undefined) throw new Error(`insights personal words: no template for ${key}`)
  const text = template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) return whole
    const value = params[name]!
    if (Array.isArray(value)) return value.join(', ')
    return name.endsWith('Date') && typeof value === 'string' ? dateWords(value) : String(value)
  })
  return Object.freeze({ key, params: Object.freeze({ ...params }), text })
}

/** A task's row words: due today (at a time) or overdue by N days, and the record it is on. */
export function taskDueWords(task: { readonly title: string; readonly dueDate: BusinessDate; readonly dueTime: string | null; readonly overdueDays: number; readonly recordLabel: string | null }): { readonly sentence: Phrase; readonly blocks: Phrase | null } {
  const sentence =
    task.overdueDays > 0
      ? personalPhrase('TASK_DUE.OVERDUE', { title: task.title, count: task.overdueDays, dueDate: task.dueDate })
      : task.dueTime
        ? personalPhrase('TASK_DUE.TODAY_AT', { title: task.title, dueTime: task.dueTime })
        : personalPhrase('TASK_DUE.TODAY', { title: task.title })
  return { sentence, blocks: task.recordLabel ? personalPhrase('TASK_DUE.on', { record: task.recordLabel }) : null }
}

/** A mention's row words: who mentioned me, on which record (the name is the author's, read for the row). */
export function mentionWords(mention: { readonly actor: string; readonly recordLabel: string }): Phrase {
  return personalPhrase('MENTION.NOTE', { actor: mention.actor, record: mention.recordLabel })
}
