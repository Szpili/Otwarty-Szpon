import { describe, expect, it } from "vitest";
import type { UsageSummary } from "../infra/provider-usage.types.js";
import { filterByBudget, type ModelCandidate } from "./token-budget.js";

describe("filterByBudget", () => {
  const candidates: ModelCandidate[] = [
    { provider: "openai-codex", model: "gpt-5.3-codex" },
    { provider: "anthropic", model: "claude-opus-4-5" },
    { provider: "google-antigravity", model: "gemini-3-flash" },
    { provider: "ollama", model: "qwen2.5-coder:7b" },
    { provider: "openrouter", model: "meta-llama/llama-3.3-70b:free" },
  ];

  it("preserves all candidates when no usage data", () => {
    const result = filterByBudget({ candidates });
    expect(result).toEqual(candidates);
  });

  it("preserves order when all providers are fresh", () => {
    const usage: UsageSummary = {
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "OpenAI",
          windows: [{ label: "daily", usedPercent: 20 }],
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [{ label: "daily", usedPercent: 30 }],
        },
        {
          provider: "google-antigravity",
          displayName: "Google",
          windows: [{ label: "daily", usedPercent: 10 }],
        },
      ],
    };
    const result = filterByBudget({ candidates, usageSummary: usage });
    expect(result).toEqual(candidates);
  });

  it("deprioritizes high-usage providers (>75%)", () => {
    const usage: UsageSummary = {
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "OpenAI",
          windows: [{ label: "daily", usedPercent: 80 }],
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [{ label: "daily", usedPercent: 20 }],
        },
        {
          provider: "google-antigravity",
          displayName: "Google",
          windows: [{ label: "daily", usedPercent: 10 }],
        },
      ],
    };
    const result = filterByBudget({ candidates, usageSummary: usage });
    // OpenAI should be after fresh providers
    const openaiIdx = result.findIndex((c) => c.provider === "openai-codex");
    const anthropicIdx = result.findIndex((c) => c.provider === "anthropic");
    const googleIdx = result.findIndex((c) => c.provider === "google-antigravity");
    expect(anthropicIdx).toBeLessThan(openaiIdx);
    expect(googleIdx).toBeLessThan(openaiIdx);
  });

  it("pushes exhausted providers (>90%) to the very end", () => {
    const usage: UsageSummary = {
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "OpenAI",
          windows: [{ label: "daily", usedPercent: 95 }],
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [{ label: "daily", usedPercent: 92 }],
        },
        {
          provider: "google-antigravity",
          displayName: "Google",
          windows: [{ label: "daily", usedPercent: 40 }],
        },
      ],
    };
    const result = filterByBudget({ candidates, usageSummary: usage });
    // Google and free providers should come before the exhausted ones
    const googleIdx = result.findIndex((c) => c.provider === "google-antigravity");
    const ollamaIdx = result.findIndex((c) => c.provider === "ollama");
    const openaiIdx = result.findIndex((c) => c.provider === "openai-codex");
    const anthropicIdx = result.findIndex((c) => c.provider === "anthropic");
    expect(googleIdx).toBeLessThan(openaiIdx);
    expect(googleIdx).toBeLessThan(anthropicIdx);
    expect(ollamaIdx).toBeLessThan(openaiIdx);
  });

  it("never filters free/local providers (ollama, openrouter)", () => {
    const usage: UsageSummary = {
      updatedAt: Date.now(),
      providers: [], // No usage data for ollama/openrouter
    };
    const result = filterByBudget({ candidates, usageSummary: usage });
    const ollamaCandidate = result.find((c) => c.provider === "ollama");
    const openrouterCandidate = result.find((c) => c.provider === "openrouter");
    expect(ollamaCandidate).toBeDefined();
    expect(openrouterCandidate).toBeDefined();
  });

  it("preserves all candidates — never drops any", () => {
    const usage: UsageSummary = {
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "OpenAI",
          windows: [{ label: "daily", usedPercent: 99 }],
        },
        {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [{ label: "daily", usedPercent: 99 }],
        },
      ],
    };
    const result = filterByBudget({ candidates, usageSummary: usage });
    expect(result).toHaveLength(candidates.length);
    for (const c of candidates) {
      expect(result).toContainEqual(c);
    }
  });

  it("uses the most restrictive usage window", () => {
    const usage: UsageSummary = {
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai-codex",
          displayName: "OpenAI",
          windows: [
            { label: "daily", usedPercent: 30 },
            { label: "monthly", usedPercent: 95 }, // This should trigger exhaustion
          ],
        },
      ],
    };
    const result = filterByBudget({ candidates, usageSummary: usage });
    const openaiIdx = result.findIndex((c) => c.provider === "openai-codex");
    // Should be pushed to the end due to 95% monthly usage
    expect(openaiIdx).toBeGreaterThan(2);
  });

  it("handles single candidate gracefully", () => {
    const single = [candidates[0]];
    const result = filterByBudget({ candidates: single });
    expect(result).toEqual(single);
  });
});
