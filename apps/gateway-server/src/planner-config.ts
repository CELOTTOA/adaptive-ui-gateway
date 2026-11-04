import { XaiModelProvider } from "@aug/model-provider-xai";
import { ModelAssistedUiPlanner } from "@aug/ui-planner";
import type { PlannerEvent, UiPlanner } from "@aug/ui-planner";

export const defaultXaiModel = "grok-4.20-0309-non-reasoning";
export const defaultPlannerTimeoutMs = 10_000;
const minTimeoutMs = 1_000;
const maxTimeoutMs = 60_000;

export interface PlannerConfig {
  /** Undefined means the gateway keeps its deterministic planner. */
  planner?: UiPlanner;
  description: string;
}

export interface PlannerConfigOverrides {
  fetch?: typeof fetch;
  onEvent?: (event: PlannerEvent) => void;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) {
    return defaultPlannerTimeoutMs;
  }
  const timeout = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(timeout) || timeout < minTimeoutMs || timeout > maxTimeoutMs) {
    throw new Error(
      `PLANNER_TIMEOUT_MS must be an integer between ${minTimeoutMs} and ${maxTimeoutMs}`,
    );
  }
  return timeout;
}

/**
 * Builds the planner from environment variables. Model planning is opt-in:
 * GROK_API_KEY enables it; XAI_MODEL and PLANNER_TIMEOUT_MS tune it.
 * Invalid settings fail at startup instead of silently degrading.
 */
export function createPlannerFromEnv(
  env: Record<string, string | undefined>,
  overrides: PlannerConfigOverrides = {},
): PlannerConfig {
  const apiKey = env.GROK_API_KEY;
  if (!apiKey) {
    return { description: "deterministic" };
  }
  const model = env.XAI_MODEL || defaultXaiModel;
  const timeoutMs = parseTimeout(env.PLANNER_TIMEOUT_MS);
  return {
    planner: new ModelAssistedUiPlanner({
      provider: new XaiModelProvider({
        apiKey,
        model,
        ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
      }),
      timeoutMs,
      ...(overrides.onEvent ? { onEvent: overrides.onEvent } : {}),
    }),
    description: `model-assisted (${model}, timeout ${timeoutMs} ms)`,
  };
}
