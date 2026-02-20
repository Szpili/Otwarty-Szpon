/**
 * Periodic model discovery cron.
 *
 * Runs model discovery at configurable intervals (default: every 24 hours).
 * Can be started as part of the agent lifecycle.
 */

import type { OpenClawConfig } from "../config/config.js";
import { loadDiscoveryState, syncFreeModels } from "./model-discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveryCronOptions = {
  cfg?: OpenClawConfig;
  /** Scan interval in hours (default: 24). */
  intervalHours?: number;
  /** Auto-install recommended Ollama models (default: false). */
  autoInstallOllama?: boolean;
  /** Max size in GB for auto-installed Ollama models (default: 8). */
  ollamaMaxSizeGb?: number;
  /** Callback for progress updates. */
  onProgress?: (phase: string, detail: string) => void;
  /** Callback when new models are discovered. */
  onNewModels?: (openRouterCount: number, ollamaCount: number) => void;
};

// ---------------------------------------------------------------------------
// Cron state
// ---------------------------------------------------------------------------

let cronTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Check whether a discovery scan is needed (based on last scan time and interval).
 */
export function isDiscoveryScanDue(intervalHours: number): boolean {
  const state = loadDiscoveryState();
  if (state.lastScanAt === 0) {
    return true;
  }
  const elapsed = Date.now() - state.lastScanAt;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return elapsed >= intervalMs;
}

/**
 * Run a single discovery cycle (if due).
 */
export async function runDiscoveryCycle(options: DiscoveryCronOptions): Promise<void> {
  if (isRunning) {
    return;
  }

  const interval = options.intervalHours ?? 24;
  if (!isDiscoveryScanDue(interval)) {
    return;
  }

  isRunning = true;
  try {
    const result = await syncFreeModels({
      cfg: options.cfg,
      autoInstallOllama: options.autoInstallOllama ?? false,
      ollamaMaxSizeGb: options.ollamaMaxSizeGb ?? 8,
      onProgress: options.onProgress,
    });

    const orCount = result.openRouterNew.length;
    const olCount = result.ollamaPulled.length;
    if (orCount > 0 || olCount > 0) {
      options.onNewModels?.(orCount, olCount);
    }
  } catch (err) {
    options.onProgress?.("error", `Discovery scan failed: ${String(err)}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the periodic model discovery cron.
 * Runs immediately (if due), then repeats at the configured interval.
 */
export function startDiscoveryCron(options: DiscoveryCronOptions): void {
  stopDiscoveryCron();

  const intervalMs = (options.intervalHours ?? 24) * 60 * 60 * 1000;

  // Run immediately (async, don't block)
  void runDiscoveryCycle(options);

  // Set up periodic runs
  cronTimer = setInterval(() => {
    void runDiscoveryCycle(options);
  }, intervalMs);

  // Don't block process exit
  if (cronTimer && typeof cronTimer === "object" && "unref" in cronTimer) {
    cronTimer.unref();
  }
}

/**
 * Stop the periodic model discovery cron.
 */
export function stopDiscoveryCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}
