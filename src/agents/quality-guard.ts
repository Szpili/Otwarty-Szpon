/**
 * Quality guard: detects streaming output degradation and triggers failover.
 *
 * Monitors the streaming text for signs of quality loss:
 * - Repetitive/looping output (same text repeated)
 * - Empty or near-empty responses
 * - Extremely slow streaming (stalled model)
 *
 * When degradation is detected, throws a FailoverError to trigger the existing
 * fallback chain — switching models mid-conversation transparently.
 */

import { FailoverError } from "./failover-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QualityGuardConfig = {
  /** Enable quality guard (default: true). */
  enabled?: boolean;
  /** Min chars expected in a response before considering it empty (default: 10). */
  minResponseChars?: number;
  /** Max seconds to wait for first token before triggering stall detection (default: 30). */
  stallTimeoutSeconds?: number;
  /** Number of repeated chunks to trigger loop detection (default: 3). */
  loopThreshold?: number;
  /** Min length of a chunk to be considered for loop detection (default: 20). */
  loopMinChunkLength?: number;
};

export type QualityGuardState = {
  chunks: string[];
  totalChars: number;
  firstChunkAt: number | null;
  startedAt: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<QualityGuardConfig> = {
  enabled: true,
  minResponseChars: 10,
  stallTimeoutSeconds: 30,
  loopThreshold: 3,
  loopMinChunkLength: 20,
};

// ---------------------------------------------------------------------------
// Quality guard implementation
// ---------------------------------------------------------------------------

/**
 * Create a new quality guard state for tracking a streaming response.
 */
export function createQualityGuardState(): QualityGuardState {
  return {
    chunks: [],
    totalChars: 0,
    firstChunkAt: null,
    startedAt: Date.now(),
  };
}

/**
 * Feed a new streaming chunk to the quality guard.
 * Throws `FailoverError` if quality degradation is detected.
 */
export function checkStreamingChunk(
  state: QualityGuardState,
  chunk: string,
  config?: QualityGuardConfig,
  context?: { provider?: string; model?: string },
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) {
    return;
  }

  // Track timing
  if (!state.firstChunkAt && chunk.length > 0) {
    state.firstChunkAt = Date.now();
  }
  state.chunks.push(chunk);
  state.totalChars += chunk.length;

  // Check for repetitive/looping output
  if (chunk.length >= cfg.loopMinChunkLength) {
    checkForLooping(state, chunk, cfg, context);
  }
}

/**
 * Check for stalled streaming (no output for a long time).
 * Call this periodically during streaming.
 */
export function checkForStall(
  state: QualityGuardState,
  config?: QualityGuardConfig,
  context?: { provider?: string; model?: string },
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) {
    return;
  }

  const elapsed = (Date.now() - state.startedAt) / 1000;
  if (elapsed > cfg.stallTimeoutSeconds && state.firstChunkAt === null) {
    throw new FailoverError(`Model stalled: no output received after ${Math.round(elapsed)}s`, {
      reason: "timeout",
      provider: context?.provider,
      model: context?.model,
    });
  }
}

/**
 * Validate the final response quality after streaming completes.
 * Throws `FailoverError` if the response is too short/empty.
 */
export function checkFinalResponse(
  state: QualityGuardState,
  config?: QualityGuardConfig,
  context?: { provider?: string; model?: string },
): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) {
    return;
  }

  if (state.totalChars < cfg.minResponseChars) {
    throw new FailoverError(
      `Model returned insufficient output (${state.totalChars} chars, minimum ${cfg.minResponseChars})`,
      {
        reason: "unknown",
        provider: context?.provider,
        model: context?.model,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function checkForLooping(
  state: QualityGuardState,
  currentChunk: string,
  cfg: Required<QualityGuardConfig>,
  context?: { provider?: string; model?: string },
): void {
  // Look at recent chunks for exact repetition
  const recentChunks = state.chunks.slice(-cfg.loopThreshold * 2);
  if (recentChunks.length < cfg.loopThreshold) {
    return;
  }

  const normalized = currentChunk.trim().toLowerCase();
  let repeatCount = 0;

  // Count how many recent chunks match the current one
  for (let i = recentChunks.length - 2; i >= 0 && repeatCount < cfg.loopThreshold; i--) {
    if (recentChunks[i].trim().toLowerCase() === normalized) {
      repeatCount++;
    } else {
      break; // Only count consecutive repeats
    }
  }

  if (repeatCount >= cfg.loopThreshold - 1) {
    throw new FailoverError(
      `Model output looping detected: "${currentChunk.slice(0, 50)}..." repeated ${repeatCount + 1} times`,
      {
        reason: "unknown",
        provider: context?.provider,
        model: context?.model,
      },
    );
  }

  // Also check for the full accumulated text showing heavy repetition
  if (state.totalChars > 500) {
    const fullText = state.chunks.join("");
    const repetitionRatio = detectRepetitionRatio(fullText);
    if (repetitionRatio > 0.6) {
      throw new FailoverError(
        `Model output heavily repetitive (${Math.round(repetitionRatio * 100)}% repeated content)`,
        {
          reason: "unknown",
          provider: context?.provider,
          model: context?.model,
        },
      );
    }
  }
}

/**
 * Detect what fraction of the text is repetitive using a simple sliding window approach.
 */
function detectRepetitionRatio(text: string): number {
  if (text.length < 100) {
    return 0;
  }

  // Check for repeating segments of various lengths
  const windowSize = Math.min(100, Math.floor(text.length / 4));
  const segment = text.slice(0, windowSize);
  let occurrences = 0;
  let pos = 0;

  while ((pos = text.indexOf(segment, pos)) !== -1) {
    occurrences++;
    pos += windowSize;
  }

  if (occurrences <= 1) {
    return 0;
  }

  // Ratio of text covered by repetitions
  return (occurrences * windowSize) / text.length;
}
