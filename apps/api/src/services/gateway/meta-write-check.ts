/**
 * The ONE value of `execution_options` Nexus sends: Meta's check (validate_only), which changes nothing.
 *
 * A leaf module (it imports nothing): meta-settings-rules.ts takes it from here, never from meta-calls.ts. So no rules file
 * takes a value from meta-calls.ts, and the rules files load in any order (meta-rules-load-order.vitest.test.ts). Before,
 * loading meta-settings-rules.ts first threw "Cannot access 'OPTIMIZATION_GOALS' before initialization".
 */
export const META_VALIDATE_ONLY = '["validate_only"]'
