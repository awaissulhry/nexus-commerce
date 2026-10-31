import { roleDefaultFor, type ViewFacts, type ViewReader } from '../rules'

/**
 * My default view of a list (B-W2b-24, followup Z12:07 of B-W2a-23; PLT-163 "Views personal, team or role default";
 * column SavedView.isPersonalDefault, B-W2b-03), pure. A person marks ONE of their own views of a list as their default:
 * the list opens on it (on an address with no terms of its own and no layout of their own) before any role default.
 *
 * The mark is a column of the view row, so it is the OWNER's: a view someone shared with me cannot be my default (the
 * row would mark it for its owner). To open a shared view by default, I save it as my own (Save view as…) and mark that
 * copy. One default per person and list (the database's partial unique index SavedView_one_personal_default): marking
 * another takes the mark off the old one in the same command. The mark changes what opens for its owner only, so it
 * needs views.save on one's own view whoever else sees it (a view shared with everyone or a role's default too: the
 * sharing is not changed).
 */

export interface PersonalDefaultFacts extends ViewFacts {
  readonly isPersonalDefault: boolean
}

/** Why the reader may not make this view their default (null: they may). */
export function personalDefaultRefusal(view: ViewFacts, reader: Pick<ViewReader, 'userId' | 'save'>): string | null {
  if (view.ownerId !== reader.userId) return 'Only a view of your own can be your default: save this one as your own view first.'
  return reader.save ? null : 'Making a view your default needs views.save.'
}

/** The reader's own default view of the list, if they marked one. */
export function personalDefaultFor<T extends PersonalDefaultFacts & { readonly id: string }>(views: readonly T[], reader: Pick<ViewReader, 'userId'>): T | null {
  return views.find((view) => view.isPersonalDefault && view.ownerId === reader.userId) ?? null
}

/** The view a list opens on for the reader: their own default first, else the default of the first role they hold that has one. */
export function openingViewFor<T extends PersonalDefaultFacts & { readonly id: string }>(views: readonly T[], reader: ViewReader): T | null {
  return personalDefaultFor(views, reader) ?? roleDefaultFor(views, reader)
}
