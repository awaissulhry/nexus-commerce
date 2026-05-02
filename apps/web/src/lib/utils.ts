/**
 * Tiny class-name joiner. Filters out falsy values so callers can write
 *   cn('base', cond && 'extra', undefined, '', condClass(x))
 * without producing stray spaces or "false"/"null" tokens. Avoids pulling
 * in clsx + tailwind-merge until we actually need conflict resolution.
 */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(' ')
}
