import type { LiveRead } from '@nexus/shared/live-read'

/** API side only: a live read plus the raw provider documents a publish review compiles its send from. Never sent to the web. */
export interface ServerLiveRead<Raw> extends LiveRead { raw: Raw }
