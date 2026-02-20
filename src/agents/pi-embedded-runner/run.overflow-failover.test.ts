import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./run/attempt.js", () => ({
  runEmbeddedAttempt: vi.fn(),
}));

vi.mock("./compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(),
}));

vi.mock("./model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      id: "test-model",
      provider: "anthropic",
      contextWindow: 200000,
      api: "messages",
    },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  })),
}));

vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({})),
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-key",
    profileId: "test-profile",
    source: "test",
  })),
  resolveAuthProfileOrder: vi.fn(() => []),
}));

vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../context-window-guard.js", () => ({
  CONTEXT_WINDOW_HARD_MIN_TOKENS: 1000,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS: 5000,
  evaluateContextWindowGuard: vi.fn(() => ({
    shouldWarn: false,
    shouldBlock: false,
    tokens: 200000,
    source: "model",
  })),
  resolveContextWindowInfo: vi.fn(() => ({
    tokens: 200000,
    source: "model",
  })),
}));

vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: vi.fn((_lane: string, task: () => unknown) => task()),
}));

vi.mock("../../utils.js", () => ({
  resolveUserPath: vi.fn((p: string) => p),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isMarkdownCapableMessageChannel: vi.fn(() => true),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

vi.mock("../auth-profiles.js", () => ({
  markAuthProfileFailure: vi.fn(async () => {}),
  markAuthProfileGood: vi.fn(async () => {}),
  markAuthProfileUsed: vi.fn(async () => {}),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200000,
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "anthropic",
}));

// No mock for failover-error.js, use real implementation

vi.mock("../usage.js", () => ({
  normalizeUsage: vi.fn(() => undefined),
}));

vi.mock("./lanes.js", () => ({
  resolveSessionLane: vi.fn(() => "session-lane"),
  resolveGlobalLane: vi.fn(() => "global-lane"),
}));

vi.mock("./logger.js", () => ({
  log: new Proxy(
    {},
    {
      get: () => vi.fn(() => false),
    },
  ),
}));

vi.mock("./run/payloads.js", () => ({
  buildEmbeddedRunPayloads: vi.fn(() => []),
}));

vi.mock("./utils.js", () => ({
  describeUnknownError: vi.fn((err: unknown) => {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }),
}));

vi.mock("../pi-embedded-helpers.js", async () => {
  return {
    isCompactionFailureError: (msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    },
    isLikelyContextOverflowError: (msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") || lower.includes("request size exceeds");
    },
    isFailoverAssistantError: vi.fn(() => false),
    isFailoverErrorMessage: vi.fn(() => false),
    isAuthAssistantError: vi.fn(() => false),
    isRateLimitAssistantError: vi.fn(() => false),
    classifyFailoverReason: vi.fn(() => null),
    formatAssistantErrorText: vi.fn(() => ""),
    pickFallbackThinkingLevel: vi.fn(() => null),
    isTimeoutErrorMessage: vi.fn(() => false),
    parseImageDimensionError: vi.fn(() => null),
  };
});

import { FailoverError } from "../failover-error.js";
import { runEmbeddedPiAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);

const baseParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
  config: {
    agents: {
      defaults: {
        model: {
          fallbacks: ["model-1", "model-2"],
        },
      },
    },
  }, // This triggers fallbackConfigured = true
};

describe("overflow failover in run loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.skip("throws FailoverError when overflow happens again after compaction with fallbacks configured", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    // Two attempts both hitting overflow
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce({
        aborted: false,
        timedOut: false,
        promptError: overflowError,
        sessionIdUsed: "test-session",
        assistantTexts: [],
        toolMetas: [],
        messagesSnapshot: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .mockResolvedValue({
        aborted: false,
        timedOut: false,
        promptError: overflowError,
        sessionIdUsed: "test-session",
        assistantTexts: [],
        toolMetas: [],
        messagesSnapshot: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    const { compactEmbeddedPiSessionDirect } = await import("./compact.js");
    vi.mocked(compactEmbeddedPiSessionDirect).mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted",
        firstKeptEntryId: "entry-3",
        tokensBefore: 180000,
      },
    });

    // Should throw FailoverError
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runEmbeddedPiAgent(baseParams as any);
      expect.fail("Should have thrown FailoverError");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error(err);
      expect(err).toBeInstanceOf(FailoverError);
      expect(err.reason).toBe("context_overflow");
    }
  });
});
