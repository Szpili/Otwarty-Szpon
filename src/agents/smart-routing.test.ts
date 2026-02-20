import { describe, expect, it } from "vitest";
import {
  applySmartRouting,
  classifyTaskType,
  type ModelCandidate,
  type TaskType,
} from "./smart-routing.js";

// ---------------------------------------------------------------------------
// classifyTaskType
// ---------------------------------------------------------------------------

describe("classifyTaskType", () => {
  const cases: Array<{ input: string; expected: TaskType }> = [
    // Code
    { input: "implement a function that sorts an array", expected: "code" },
    {
      input: "debug this TypeScript error:\n```\nType 'string' is not assignable\n```",
      expected: "code",
    },
    { input: "refactor the database schema migration", expected: "code" },
    { input: "write unit tests for the API endpoint", expected: "code" },
    { input: "fix the bug in utils.ts where const is reassigned", expected: "code" },
    { input: "create a React component with state and props", expected: "code" },
    { input: "npm install and build the project", expected: "code" },
    { input: "review this pull request on the main branch", expected: "code" },

    // Reasoning
    { input: "explain why the sky is blue", expected: "reasoning" },
    { input: "analyze the pros and cons of microservices", expected: "reasoning" },
    { input: "think through the implications step by step", expected: "reasoning" },
    { input: "compare advantages and disadvantages of React vs Vue", expected: "reasoning" },
    { input: "calculate the integral of x² from 0 to 5", expected: "reasoning" },
    { input: "evaluate the trade-offs between speed and accuracy", expected: "reasoning" },

    // Creative
    { input: "write a story about a robot who learns to love", expected: "creative" },
    { input: "write a haiku about the ocean", expected: "creative" },
    { input: "brainstorm creative names for my startup", expected: "creative" },
    { input: "rewrite this in a more professional tone", expected: "creative" },
    { input: "write a catchy tagline for our product", expected: "creative" },

    // Translation
    { input: "translate this to Polish", expected: "translation" },
    { input: "how do you say this in French", expected: "translation" },
    { input: "przetłumacz na polski", expected: "translation" },
    { input: "translate into Japanese", expected: "translation" },
    { input: "localization for the i18n strings", expected: "translation" },

    // General
    { input: "hello", expected: "general" },
    { input: "what time is it", expected: "general" },
    { input: "thanks", expected: "general" },
    { input: "", expected: "general" },
  ];

  for (const { input, expected } of cases) {
    const label = input.length > 60 ? `${input.slice(0, 57)}...` : input || "(empty)";
    it(`classifies "${label}" as ${expected}`, () => {
      expect(classifyTaskType(input)).toBe(expected);
    });
  }

  it("returns general for null/undefined", () => {
    expect(classifyTaskType(null as unknown as string)).toBe("general");
    expect(classifyTaskType(undefined as unknown as string)).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// applySmartRouting
// ---------------------------------------------------------------------------

describe("applySmartRouting", () => {
  const candidates: ModelCandidate[] = [
    { provider: "openai-codex", model: "gpt-5.3-codex" },
    { provider: "google-antigravity", model: "gemini-3-flash" },
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" },
    { provider: "openrouter", model: "qwen/qwen3-coder:free" },
    { provider: "google-antigravity", model: "claude-opus-4-5" },
  ];

  it("promotes code models for coding prompts", () => {
    const result = applySmartRouting({
      candidates,
      prompt: "implement a TypeScript function that parses JSON",
    });
    // codex, deepseek, and qwen should come first
    const firstThree = result.slice(0, 3).map((c) => `${c.provider}/${c.model}`);
    expect(firstThree).toContain("openai-codex/gpt-5.3-codex");
    expect(firstThree).toContain("deepseek/deepseek-chat");
  });

  it("promotes creative models for creative prompts", () => {
    const result = applySmartRouting({
      candidates,
      prompt: "write a story about a dragon and a knight",
    });
    const first = `${result[0].provider}/${result[0].model}`;
    // Claude or Gemini should be promoted
    expect(first).toMatch(/claude|gemini/i);
  });

  it("promotes translation models for translation prompts", () => {
    const result = applySmartRouting({
      candidates,
      prompt: "translate this text to Polish",
    });
    const first = `${result[0].provider}/${result[0].model}`;
    expect(first).toMatch(/gemini|qwen/i);
  });

  it("preserves original order for general prompts", () => {
    const result = applySmartRouting({
      candidates,
      prompt: "hello there",
    });
    expect(result).toEqual(candidates);
  });

  it("preserves original order when routing is disabled", () => {
    const result = applySmartRouting({
      candidates,
      prompt: "implement a function",
      cfg: {
        agents: {
          defaults: {
            smartRouting: { enabled: false },
          },
        },
      } as unknown as import("../config/config.js").OpenClawConfig,
    });
    expect(result).toEqual(candidates);
  });

  it("returns candidates unchanged when no prompt", () => {
    const result = applySmartRouting({ candidates });
    expect(result).toEqual(candidates);
  });

  it("returns candidates unchanged with single candidate", () => {
    const single = [candidates[0]];
    const result = applySmartRouting({
      candidates: single,
      prompt: "implement a function",
    });
    expect(result).toEqual(single);
  });

  it("preserves all candidates (no drops)", () => {
    const result = applySmartRouting({
      candidates,
      prompt: "implement a TypeScript function",
    });
    expect(result).toHaveLength(candidates.length);
    // Every original candidate should still be present
    for (const c of candidates) {
      expect(result).toContainEqual(c);
    }
  });

  it("respects custom routing rules", () => {
    const result = applySmartRouting({
      candidates,
      prompt: "implement a function",
      cfg: {
        agents: {
          defaults: {
            smartRouting: {
              enabled: true,
              rules: {
                code: ["llama", "gemini"], // custom: prefer llama & gemini for code
              },
            },
          },
        },
      } as unknown as import("../config/config.js").OpenClawConfig,
    });
    const firstTwo = result.slice(0, 2).map((c) => `${c.provider}/${c.model}`);
    expect(firstTwo[0]).toMatch(/llama/i);
    expect(firstTwo[1]).toMatch(/gemini/i);
  });
});
