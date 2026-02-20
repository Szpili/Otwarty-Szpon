/**
 * Model discovery: auto-discover free OpenRouter models and pull Ollama models.
 *
 * Uses existing scanOpenRouterModels() for online free-model discovery
 * and the Ollama REST API for model pulling.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { scanOpenRouterModels } from "./model-scan.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveredModel = {
  id: string;
  name: string;
  provider: "openrouter" | "ollama";
  modelRef: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  isFree: boolean;
  supportsTools: boolean;
  discoveredAt: number;
  /** Inferred parameter size in billions. */
  paramB: number | null;
};

export type DiscoveryState = {
  lastScanAt: number;
  models: DiscoveredModel[];
};

export type OllamaPullProgress = {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLLAMA_API_BASE = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const DISCOVERY_FILE = path.join(homedir(), ".openclaw", "discovered-models.json");

/**
 * Curated list of high-quality Ollama models worth auto-pulling.
 * These are generally the best open-source models for their categories.
 */
export const RECOMMENDED_OLLAMA_MODELS: Array<{
  id: string;
  category: "code" | "reasoning" | "general" | "creative";
  sizeGb: number;
}> = [
  { id: "qwen2.5-coder:7b", category: "code", sizeGb: 4.7 },
  { id: "qwen2.5-coder:14b", category: "code", sizeGb: 9.0 },
  { id: "deepseek-r1:8b", category: "reasoning", sizeGb: 4.9 },
  { id: "deepseek-r1:14b", category: "reasoning", sizeGb: 9.0 },
  { id: "llama3.3:8b", category: "general", sizeGb: 4.7 },
  { id: "gemma3:12b", category: "general", sizeGb: 8.1 },
  { id: "mistral:7b", category: "creative", sizeGb: 4.1 },
];

// ---------------------------------------------------------------------------
// Discovery state persistence
// ---------------------------------------------------------------------------

export function loadDiscoveryState(): DiscoveryState {
  try {
    if (existsSync(DISCOVERY_FILE)) {
      const raw = readFileSync(DISCOVERY_FILE, "utf-8");
      return JSON.parse(raw) as DiscoveryState;
    }
  } catch {
    // Corrupt file — start fresh.
  }
  return { lastScanAt: 0, models: [] };
}

export function saveDiscoveryState(state: DiscoveryState): void {
  const dir = path.dirname(DISCOVERY_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(DISCOVERY_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// OpenRouter free model discovery
// ---------------------------------------------------------------------------

/**
 * Discover new free models on OpenRouter that are not yet in the current config.
 * Returns only genuinely new models that support tool calls.
 */
export async function discoverFreeOpenRouterModels(params?: {
  cfg?: OpenClawConfig;
  minParamB?: number;
  maxAgeDays?: number;
}): Promise<DiscoveredModel[]> {
  const existingState = loadDiscoveryState();
  const existingIds = new Set(existingState.models.map((m) => m.id));

  // Also collect model ids already in config/providers
  const configIds = new Set<string>();
  const providers = params?.cfg?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const providerConfig of Object.values(providers)) {
      if (providerConfig && typeof providerConfig === "object" && "models" in providerConfig) {
        const models = (providerConfig as { models?: Array<{ id?: string }> }).models;
        if (Array.isArray(models)) {
          for (const m of models) {
            if (m.id) {
              configIds.add(m.id);
            }
          }
        }
      }
    }
  }

  const scanResults = await scanOpenRouterModels({
    probe: false, // catalog-only, no live probing (fast)
    minParamB: params?.minParamB ?? 7,
    maxAgeDays: params?.maxAgeDays ?? 90,
  });

  const now = Date.now();
  const newModels: DiscoveredModel[] = [];

  for (const result of scanResults) {
    if (existingIds.has(result.id) || configIds.has(result.id)) {
      continue;
    }
    // Only models that report tool support in their metadata
    if (!result.supportsToolsMeta) {
      continue;
    }
    newModels.push({
      id: result.id,
      name: result.name,
      provider: "openrouter",
      modelRef: `openrouter/${result.id}`,
      contextLength: result.contextLength,
      maxCompletionTokens: result.maxCompletionTokens,
      isFree: result.isFree,
      supportsTools: result.supportsToolsMeta,
      discoveredAt: now,
      paramB: result.inferredParamB,
    });
  }

  return newModels;
}

// ---------------------------------------------------------------------------
// Ollama model management
// ---------------------------------------------------------------------------

type OllamaTagsResponse = {
  models?: Array<{ name: string; size?: number }>;
};

/**
 * List locally installed Ollama models.
 */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/**
 * Pull (download) an Ollama model.
 * Returns true if the model was successfully pulled.
 */
export async function pullOllamaModel(
  modelId: string,
  onProgress?: (progress: OllamaPullProgress) => void,
): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelId, stream: true }),
    });
    if (!res.ok) {
      console.warn(`Ollama pull failed for ${modelId}: HTTP ${res.status}`);
      return false;
    }

    // Stream progress updates (NDJSON)
    const reader = res.body?.getReader();
    if (!reader) {
      return false;
    }
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const progress = JSON.parse(line) as OllamaPullProgress;
          onProgress?.(progress);
        } catch {
          // Skip malformed lines.
        }
      }
    }

    return true;
  } catch (err) {
    console.warn(`Ollama pull failed for ${modelId}: ${String(err)}`);
    return false;
  }
}

/**
 * Install recommended Ollama models that are not yet locally available.
 * Respects the max size limit.
 */
export async function installRecommendedOllamaModels(params?: {
  maxSizeGb?: number;
  categories?: string[];
  onProgress?: (model: string, progress: OllamaPullProgress) => void;
  onInstalled?: (model: string) => void;
}): Promise<string[]> {
  const maxGb = params?.maxSizeGb ?? 8;
  const categories = params?.categories;
  const installed = await listOllamaModels();
  const installedSet = new Set(installed.map((m) => m.toLowerCase()));
  const pulled: string[] = [];

  for (const rec of RECOMMENDED_OLLAMA_MODELS) {
    // Skip if already installed
    if (installedSet.has(rec.id.toLowerCase())) {
      continue;
    }
    // Skip if too large
    if (rec.sizeGb > maxGb) {
      continue;
    }
    // Filter by category if specified
    if (categories && !categories.includes(rec.category)) {
      continue;
    }

    const success = await pullOllamaModel(rec.id, (progress) => {
      params?.onProgress?.(rec.id, progress);
    });
    if (success) {
      pulled.push(rec.id);
      params?.onInstalled?.(rec.id);
    }
  }

  return pulled;
}

// ---------------------------------------------------------------------------
// Unified sync
// ---------------------------------------------------------------------------

export type SyncFreeModelsResult = {
  openRouterNew: DiscoveredModel[];
  ollamaPulled: string[];
};

/**
 * Full model sync:
 * 1. Discover new free models on OpenRouter.
 * 2. Optionally auto-install recommended Ollama models.
 * 3. Persist the discovery state.
 */
export async function syncFreeModels(params?: {
  cfg?: OpenClawConfig;
  autoInstallOllama?: boolean;
  ollamaMaxSizeGb?: number;
  onProgress?: (phase: string, detail: string) => void;
}): Promise<SyncFreeModelsResult> {
  const state = loadDiscoveryState();

  // Phase 1: OpenRouter discovery
  params?.onProgress?.("openrouter", "Scanning for free models...");
  const openRouterNew = await discoverFreeOpenRouterModels({ cfg: params?.cfg });

  // Add newly discovered models to state
  for (const model of openRouterNew) {
    state.models.push(model);
  }

  // Phase 2: Ollama auto-install (if enabled)
  let ollamaPulled: string[] = [];
  if (params?.autoInstallOllama !== false) {
    params?.onProgress?.("ollama", "Checking recommended models...");
    ollamaPulled = await installRecommendedOllamaModels({
      maxSizeGb: params?.ollamaMaxSizeGb ?? 8,
      onInstalled: (model) => {
        params?.onProgress?.("ollama", `Installed ${model}`);
      },
    });

    // Add installed Ollama models to discovery state
    const now = Date.now();
    for (const id of ollamaPulled) {
      state.models.push({
        id,
        name: id,
        provider: "ollama",
        modelRef: `ollama/${id}`,
        contextLength: null,
        maxCompletionTokens: null,
        isFree: true,
        supportsTools: false,
        discoveredAt: now,
        paramB: null,
      });
    }
  }

  // Persist
  state.lastScanAt = Date.now();
  saveDiscoveryState(state);

  return { openRouterNew, ollamaPulled };
}
