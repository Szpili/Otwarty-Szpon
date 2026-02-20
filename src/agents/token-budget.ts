/**
 * Token budget steering for smart model routing.
 *
 * Reads existing provider-usage data (already tracked by OpenClaw) and
 * deprioritizes or removes candidates whose providers are near their quota limits.
 *
 * This is a secondary filter applied after task-type classification.
 */

import type { OpenClawConfig } from "../config/config.js";
import { loadProviderUsageSummary } from "../infra/provider-usage.load.js";
import type { UsageSummary, UsageProviderId } from "../infra/provider-usage.types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelCandidate = {
  provider: string;
  model: string;
};

export type BudgetStatus = {
  provider: string;
  usedPercent: number;
  isExhausted: boolean;
  resetAt?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold at which a provider is considered "nearly exhausted" (90%). */
const EXHAUSTION_THRESHOLD = 90;

/** Threshold at which a provider is deprioritized but not removed (75%). */
const DEPRIORITIZE_THRESHOLD = 75;

// ---------------------------------------------------------------------------
// Provider usage → budget status
// ---------------------------------------------------------------------------

/**
 * Map a model candidate's provider to a `UsageProviderId` used by the usage tracker.
 * Handles the mismatch between provider names in model refs vs. usage tracking.
 */
function mapToUsageProviderId(provider: string): UsageProviderId | null {
  const normalized = provider.toLowerCase().trim();

  const mapping: Record<string, UsageProviderId> = {
    anthropic: "anthropic",
    "openai-codex": "openai-codex",
    openai: "openai-codex",
    "google-antigravity": "google-antigravity",
    "google-gemini-cli": "google-gemini-cli",
    google: "google-antigravity",
    "github-copilot": "github-copilot",
    minimax: "minimax",
    xiaomi: "xiaomi",
    zai: "zai",
  };

  return mapping[normalized] ?? null;
}

/**
 * Get the budget status for a specific provider.
 */
function getProviderBudget(provider: string, usageSummary: UsageSummary | null): BudgetStatus {
  const defaultStatus: BudgetStatus = {
    provider,
    usedPercent: 0,
    isExhausted: false,
  };

  if (!usageSummary) {
    return defaultStatus;
  }

  const usageId = mapToUsageProviderId(provider);
  if (!usageId) {
    return defaultStatus; // Unknown provider — assume unlimited (e.g., ollama, openrouter free)
  }

  const snapshot = usageSummary.providers.find((p) => p.provider === usageId);
  if (!snapshot || snapshot.windows.length === 0) {
    return defaultStatus;
  }

  // Use the most restrictive window (highest usedPercent)
  let maxUsed = 0;
  let nearestReset: number | undefined;
  for (const window of snapshot.windows) {
    if (window.usedPercent > maxUsed) {
      maxUsed = window.usedPercent;
      nearestReset = window.resetAt;
    }
  }

  return {
    provider,
    usedPercent: maxUsed,
    isExhausted: maxUsed >= EXHAUSTION_THRESHOLD,
    resetAt: nearestReset,
  };
}

// ---------------------------------------------------------------------------
// Budget-aware candidate filtering
// ---------------------------------------------------------------------------

/**
 * Filter and reorder candidates based on provider token budgets.
 *
 * - **Exhausted providers** (>90% usage): moved to the very end of the list.
 *   Still available as last resort, but not preferred.
 * - **High-usage providers** (>75%): deprioritized (moved after fresh providers
 *   but before exhausted ones).
 * - **Fresh providers** (<75%): kept in their current order.
 *
 * Local providers (ollama, openrouter free) are never filtered since they're free/unlimited.
 */
export function filterByBudget(params: {
  candidates: ModelCandidate[];
  usageSummary?: UsageSummary | null;
}): ModelCandidate[] {
  const { candidates, usageSummary } = params;

  if (!usageSummary || candidates.length <= 1) {
    return candidates;
  }

  const fresh: ModelCandidate[] = [];
  const highUsage: ModelCandidate[] = [];
  const exhausted: ModelCandidate[] = [];

  for (const candidate of candidates) {
    const budget = getProviderBudget(candidate.provider, usageSummary);

    if (budget.isExhausted) {
      exhausted.push(candidate);
    } else if (budget.usedPercent >= DEPRIORITIZE_THRESHOLD) {
      highUsage.push(candidate);
    } else {
      fresh.push(candidate);
    }
  }

  return [...fresh, ...highUsage, ...exhausted];
}

/**
 * Load usage summary and apply budget filtering to candidates.
 * Convenience wrapper that loads the current usage data.
 */
export async function applyBudgetSteering(params: {
  candidates: ModelCandidate[];
  cfg?: OpenClawConfig;
}): Promise<ModelCandidate[]> {
  try {
    const usageSummary = await loadProviderUsageSummary();
    return filterByBudget({
      candidates: params.candidates,
      usageSummary,
    });
  } catch {
    // If usage data is unavailable, don't block routing
    return params.candidates;
  }
}
