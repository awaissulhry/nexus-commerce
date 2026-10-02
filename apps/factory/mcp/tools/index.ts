/** P11/P12 — every factory tool the stdio server may offer (each still filtered by the token's scopes and the person's permissions). */
import { READ_TOOLS } from "./read";
import { DRAFT_TOOLS } from "./drafts";
import type { FactoryTool } from "./types";

export const ALL_TOOLS: FactoryTool[] = [...READ_TOOLS, ...DRAFT_TOOLS];
