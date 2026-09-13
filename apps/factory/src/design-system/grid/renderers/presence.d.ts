/** Presence is its own vocabulary. No conversion to either readiness axis is defined here. */
import type { Tone } from '../../primitives/tone';
export type PresenceIntent = 'NONE' | 'DRAFT' | 'LIVE' | 'HELD' | 'WITHDRAWN' | 'ENDED' | 'DISCONTINUED' | 'RELEASED';
export type ChannelFact = 'UNKNOWN' | 'SELLING' | 'NOT_SELLING' | 'SUPPRESSED' | 'ABSENT' | 'REFUSED';
export type PresenceVerdict = 'agrees' | 'pending' | 'diverged' | 'unknown' | 'unreachable';
export interface PresenceMeta {
    label: string;
    tone: Tone;
    sentence: string;
}
export declare const intentMeta: (intent: PresenceIntent) => PresenceMeta;
export declare const factMeta: (fact: ChannelFact) => PresenceMeta;
export declare const verdictMeta: (verdict: PresenceVerdict) => PresenceMeta;
export declare const PRESENCE_INTENTS: PresenceIntent[];
export declare const CHANNEL_FACTS: ChannelFact[];
export declare const PRESENCE_VERDICTS: PresenceVerdict[];
export interface Presence {
    intent: PresenceIntent;
    intentAt: string | null;
    fact: ChannelFact;
    observedAt: string | null;
    inFlight: boolean;
    /** The read owns the freshness window; the renderer must not invent a timeout. */
    now: number;
    freshnessMs: number;
}
export declare function presenceVerdict(p: Presence): PresenceVerdict;
export declare function presenceLine(p: Presence): {
    intent: PresenceMeta;
    fact: PresenceMeta;
    verdict: PresenceMeta;
    asOf: string | null;
    sentence: string;
};
