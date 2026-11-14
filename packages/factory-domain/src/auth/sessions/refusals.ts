/**
 * The codes of a refused session change (B-W2b-404; PLT-064; path `sessions/<code>`); the web says its own words.
 */
export const SESSION_REFUSALS = Object.freeze({
  notFound: 'This session has ended already, or it is not yours.',
  current: 'This is the browser you are using: sign out instead.',
  self: 'Your own sessions are ended in My profile › Where I am signed in.',
})
export type SessionRefusal = keyof typeof SESSION_REFUSALS
