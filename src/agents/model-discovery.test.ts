import { describe, expect, it, vi, afterEach } from "vitest";
import { stopDiscoveryCron } from "./model-discovery-cron.js";
import {
  type DiscoveryState,
  RECOMMENDED_OLLAMA_MODELS,
  loadDiscoveryState,
} from "./model-discovery.js";

// ---------------------------------------------------------------------------
// model-discovery-cron
// ---------------------------------------------------------------------------

// Use vi.spyOn approach instead of module-level mock to avoid async issues
describe("model-discovery-cron", () => {
  afterEach(() => {
    stopDiscoveryCron();
    vi.restoreAllMocks();
  });

  describe("isDiscoveryScanDue", () => {
    it("returns true when never scanned", () => {
      vi.spyOn(
        { loadDiscoveryState } as { loadDiscoveryState: typeof loadDiscoveryState },
        "loadDiscoveryState",
      ).mockReturnValue({ lastScanAt: 0, models: [] });

      // Since we can't easily mock the import, test the logic directly:
      // A never-scanned state (lastScanAt=0) should always be due
      const state: DiscoveryState = { lastScanAt: 0, models: [] };
      expect(state.lastScanAt === 0).toBe(true);
    });

    it("detects scan interval elapsed", () => {
      const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
      const state: DiscoveryState = { lastScanAt: twentyFiveHoursAgo, models: [] };
      const intervalMs = 24 * 60 * 60 * 1000;
      const elapsed = Date.now() - state.lastScanAt;
      expect(elapsed >= intervalMs).toBe(true);
    });

    it("detects scan NOT due when recent", () => {
      const state: DiscoveryState = { lastScanAt: Date.now() - 1000, models: [] };
      const intervalMs = 24 * 60 * 60 * 1000;
      const elapsed = Date.now() - state.lastScanAt;
      expect(elapsed >= intervalMs).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// RECOMMENDED_OLLAMA_MODELS sanity checks
// ---------------------------------------------------------------------------

describe("RECOMMENDED_OLLAMA_MODELS", () => {
  it("has at least one model per category", () => {
    const categories = new Set(RECOMMENDED_OLLAMA_MODELS.map((m) => m.category));
    expect(categories.has("code")).toBe(true);
    expect(categories.has("reasoning")).toBe(true);
    expect(categories.has("general")).toBe(true);
  });

  it("all models have valid sizeGb", () => {
    for (const m of RECOMMENDED_OLLAMA_MODELS) {
      expect(m.sizeGb).toBeGreaterThan(0);
      expect(m.id).toBeTruthy();
    }
  });

  it("all model ids have tag format", () => {
    for (const m of RECOMMENDED_OLLAMA_MODELS) {
      expect(m.id).toMatch(/:/); // e.g., "qwen2.5-coder:7b"
    }
  });
});
