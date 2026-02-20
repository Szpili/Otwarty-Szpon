import { describe, expect, it } from "vitest";
import { FailoverError } from "./failover-error.js";
import {
  checkFinalResponse,
  checkForStall,
  checkStreamingChunk,
  createQualityGuardState,
} from "./quality-guard.js";

describe("quality-guard", () => {
  describe("checkStreamingChunk - loop detection", () => {
    it("detects exact repetitive chunks", () => {
      const state = createQualityGuardState();
      const repeatedChunk = "This is a repeated output that keeps going and going";

      // Feed the same chunk repeatedly
      expect(() => {
        for (let i = 0; i < 5; i++) {
          checkStreamingChunk(state, repeatedChunk);
        }
      }).toThrow(FailoverError);
    });

    it("does not trigger for varied chunks", () => {
      const state = createQualityGuardState();
      expect(() => {
        checkStreamingChunk(state, "First chunk of normal output here");
        checkStreamingChunk(state, "Second chunk is different content");
        checkStreamingChunk(state, "Third chunk has unique content too");
        checkStreamingChunk(state, "Fourth chunk wraps up the response");
      }).not.toThrow();
    });

    it("ignores short chunks for loop detection", () => {
      const state = createQualityGuardState();
      expect(() => {
        for (let i = 0; i < 10; i++) {
          checkStreamingChunk(state, "ok"); // too short
        }
      }).not.toThrow();
    });
  });

  describe("checkForStall", () => {
    it("throws on stall when no output received after timeout", () => {
      const state = createQualityGuardState();
      // Simulate old start time
      state.startedAt = Date.now() - 35_000;
      expect(() => checkForStall(state, { stallTimeoutSeconds: 30 })).toThrow(FailoverError);
    });

    it("does not throw if first chunk received", () => {
      const state = createQualityGuardState();
      state.startedAt = Date.now() - 35_000;
      state.firstChunkAt = Date.now() - 30_000;
      expect(() => checkForStall(state, { stallTimeoutSeconds: 30 })).not.toThrow();
    });

    it("does not throw before timeout", () => {
      const state = createQualityGuardState();
      expect(() => checkForStall(state, { stallTimeoutSeconds: 30 })).not.toThrow();
    });
  });

  describe("checkFinalResponse", () => {
    it("throws for empty responses", () => {
      const state = createQualityGuardState();
      expect(() => checkFinalResponse(state)).toThrow(FailoverError);
    });

    it("throws for very short responses", () => {
      const state = createQualityGuardState();
      state.totalChars = 5;
      expect(() => checkFinalResponse(state, { minResponseChars: 10 })).toThrow(FailoverError);
    });

    it("accepts normal-length responses", () => {
      const state = createQualityGuardState();
      state.totalChars = 500;
      expect(() => checkFinalResponse(state)).not.toThrow();
    });
  });

  describe("disabled guard", () => {
    it("never throws when disabled", () => {
      const state = createQualityGuardState();
      state.startedAt = Date.now() - 60_000;
      expect(() => {
        checkForStall(state, { enabled: false });
        checkFinalResponse(state, { enabled: false });
        for (let i = 0; i < 10; i++) {
          checkStreamingChunk(state, "Repeated long chunk of content here", { enabled: false });
        }
      }).not.toThrow();
    });
  });

  describe("error metadata", () => {
    it("includes provider and model context in FailoverError", () => {
      const state = createQualityGuardState();
      try {
        checkFinalResponse(state, undefined, {
          provider: "openai",
          model: "gpt-4",
        });
      } catch (err) {
        expect(err).toBeInstanceOf(FailoverError);
        const e = err as FailoverError;
        expect(e.provider).toBe("openai");
        expect(e.model).toBe("gpt-4");
      }
    });
  });
});
