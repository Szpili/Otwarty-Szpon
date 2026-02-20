/**
 * Smart task-based model routing for OpenClaw.
 *
 * Classifies user prompts by task type and reorders fallback candidates
 * to promote the best-suited model for each task category.
 *
 * Zero latency: uses regex patterns only, no LLM calls.
 */

import type { OpenClawConfig } from "../config/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskType = "code" | "reasoning" | "creative" | "translation" | "general";

export type SmartRoutingConfig = {
  enabled?: boolean;
  /** Ordered model-id fragment preferences per task type. */
  rules?: Partial<Record<TaskType, string[]>>;
};

export type ModelCandidate = {
  provider: string;
  model: string;
};

// ---------------------------------------------------------------------------
// Default routing rules
// ---------------------------------------------------------------------------

/**
 * Default model affinity rules.
 * Each array lists model-id fragments in priority order.
 * A candidate matches if its `provider/model` key contains the fragment (case-insensitive).
 */
export const DEFAULT_ROUTING_RULES: Record<TaskType, string[]> = {
  code: ["codex", "deepseek", "qwen", "coder"],
  reasoning: ["deepseek", "codex", "claude", "r1"],
  creative: ["claude", "gemini", "llama", "opus"],
  translation: ["gemini", "qwen", "deepseek", "glm"],
  general: [], // no reordering — keep original config order
};

// ---------------------------------------------------------------------------
// Task classifier
// ---------------------------------------------------------------------------

/** Code-related patterns. */
const CODE_PATTERNS = [
  // Direct keywords
  /\b(?:function|class|const|let|var|import|export|return|async|await)\b/i,
  /\b(?:implement|refactor|debug|bugfix|compile|build|deploy|lint)\b/i,
  /\b(?:api|endpoint|database|schema|migration|query|sql)\b/i,
  /\b(?:component|hook|state|props|render|dom|css|html)\b/i,
  /\b(?:test|spec|assert|mock|stub|fixture)\b/i,
  /\b(?:git|commit|merge|branch|pull\s*request|pr)\b/i,
  /\b(?:npm|pnpm|yarn|pip|cargo|docker|kubernetes)\b/i,
  // File extensions
  /\.\b(?:ts|tsx|js|jsx|py|rs|go|java|cpp|c|rb|swift|kt)\b/,
  // Code blocks
  /```[\s\S]*```/,
  // Stack traces / errors
  /(?:error|exception|traceback|stack\s*trace)\s*:/i,
  /\bat\s+\S+\s*\(\S+:\d+:\d+\)/,
];

/** Reasoning / analytical patterns. */
const REASONING_PATTERNS = [
  /\b(?:explain\s+(?:why|how|what))\b/i,
  /\b(?:analyze|analyse|evaluate|compare|contrast|assess)\b/i,
  /\b(?:think\s+through|step\s+by\s+step|reasoning|logic)\b/i,
  /\b(?:pros?\s+(?:and|&)\s+cons?|trade-?offs?|advantages?\s+(?:and|&)\s+disadvantages?)\b/i,
  /\b(?:calculate|equation|formula|theorem|proof|derive)\b/i,
  /\b(?:cause|effect|consequence|implication|hypothesis)\b/i,
  // Math symbols
  /[∑∏∫√∂∇≈≠≤≥±×÷]/,
  /\b(?:sigma|integral|derivative|matrix|vector)\b/i,
];

/** Creative patterns. */
const CREATIVE_PATTERNS = [
  /\b(?:write\s+(?:a\s+)?(?:story|poem|haiku|song|lyrics|script|essay|letter|blog))\b/i,
  /\b(?:creative|brainstorm|imagine|fiction|narrative|character)\b/i,
  /\b(?:tone|voice|style|mood|metaphor|analogy)\b/i,
  /\b(?:rewrite|paraphrase|rephrase)\s+(?:this|the|in)\b/i,
  /\b(?:copywriting|tagline|slogan|headline|pitch)\b/i,
];

/** Translation patterns. */
const TRANSLATION_PATTERNS = [
  /\b(?:translate|translation|translator)\b/i,
  /\b(?:in|to|into)\s+(?:polish|french|german|spanish|italian|portuguese|chinese|japanese|korean|arabic|russian|hindi|turkish|dutch|swedish|czech|slovak|hungarian|romanian|greek|thai|vietnamese|indonesian|malay|filipino|hebrew|farsi|persian|ukrainian|bengali|tamil|telugu|marathi|gujarati|kannada|malayalam|urdu|swahili)\b/i,
  /\b(?:po\s+polsku|na\s+polski|en\s+fran[cç]ais|auf\s+deutsch|en\s+espa[nñ]ol)\b/i,
  /\b(?:localize|localization|i18n|l10n)\b/i,
];

/**
 * Classify a user prompt into a task type using fast pattern matching.
 * Returns the task type with the highest match count, or "general" if no patterns match.
 */
export function classifyTaskType(prompt: string): TaskType {
  if (!prompt || typeof prompt !== "string") {
    return "general";
  }

  const scores: Record<TaskType, number> = {
    code: 0,
    reasoning: 0,
    creative: 0,
    translation: 0,
    general: 0,
  };

  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(prompt)) {
      scores.code += 1;
    }
  }
  for (const pattern of REASONING_PATTERNS) {
    if (pattern.test(prompt)) {
      scores.reasoning += 1;
    }
  }
  for (const pattern of CREATIVE_PATTERNS) {
    if (pattern.test(prompt)) {
      scores.creative += 1;
    }
  }
  for (const pattern of TRANSLATION_PATTERNS) {
    if (pattern.test(prompt)) {
      scores.translation += 1;
    }
  }

  // Find highest scoring category (minimum 1 match required)
  let best: TaskType = "general";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores) as [TaskType, number][]) {
    if (type === "general") {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Candidate reordering
// ---------------------------------------------------------------------------

function candidateKey(c: ModelCandidate): string {
  return `${c.provider}/${c.model}`.toLowerCase();
}

/**
 * Check whether a candidate matches any fragment in the affinity list.
 * Returns the index of the first matching fragment (lower = higher priority),
 * or -1 if no match.
 */
function matchAffinity(candidate: ModelCandidate, fragments: string[]): number {
  const key = candidateKey(candidate);
  for (let i = 0; i < fragments.length; i++) {
    if (key.includes(fragments[i].toLowerCase())) {
      return i;
    }
  }
  return -1;
}

/**
 * Resolve the smart routing config from the OpenClaw config.
 */
function resolveSmartRoutingConfig(cfg?: OpenClawConfig): SmartRoutingConfig {
  const raw = (cfg?.agents?.defaults as Record<string, unknown> | undefined)?.smartRouting;
  if (!raw || typeof raw !== "object") {
    return { enabled: true };
  }
  return raw as SmartRoutingConfig;
}

/**
 * Reorder model candidates based on task type affinity.
 *
 * - Candidates matching the task's preferred model fragments are promoted to the front,
 *   ordered by their position in the affinity list.
 * - Non-matching candidates retain their original relative order at the end.
 * - If routing is disabled or task is "general", returns candidates unchanged.
 */
export function applySmartRouting(params: {
  candidates: ModelCandidate[];
  prompt?: string;
  cfg?: OpenClawConfig;
}): ModelCandidate[] {
  const { candidates, prompt, cfg } = params;

  if (!prompt || candidates.length <= 1) {
    return candidates;
  }

  const routingCfg = resolveSmartRoutingConfig(cfg);
  if (routingCfg.enabled === false) {
    return candidates;
  }

  const taskType = classifyTaskType(prompt);
  if (taskType === "general") {
    return candidates;
  }

  const rules = routingCfg.rules ?? DEFAULT_ROUTING_RULES;
  const fragments = rules[taskType] ?? DEFAULT_ROUTING_RULES[taskType] ?? [];
  if (fragments.length === 0) {
    return candidates;
  }

  // Score each candidate: matched candidates get their affinity index,
  // unmatched get Infinity to sort to the end.
  const scored = candidates.map((candidate, originalIndex) => {
    const affinityIndex = matchAffinity(candidate, fragments);
    return {
      candidate,
      affinityIndex: affinityIndex >= 0 ? affinityIndex : Infinity,
      originalIndex,
    };
  });

  // Sort: by affinity index first, then by original position for ties.
  scored.sort((a, b) => {
    if (a.affinityIndex !== b.affinityIndex) {
      return a.affinityIndex - b.affinityIndex;
    }
    return a.originalIndex - b.originalIndex;
  });

  return scored.map((s) => s.candidate);
}
