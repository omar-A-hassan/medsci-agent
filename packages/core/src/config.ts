import type { HardwareProfile, ProfileConfig } from "./types";
import { PROFILES } from "./types";

export interface MedSciConfig {
  profileConfig: ProfileConfig;
  ollama: {
    baseUrl: string;
    defaultModel: string;
    timeoutMs: number;
  };
  python: {
    binary: string;
    timeoutMs: number;
  };
}

/**
 * Resolve configuration from environment variables with sensible defaults.
 * Uses Ollama as the model backend.
 */
export function resolveConfig(): MedSciConfig {
  const profile = (process.env.MEDSCI_PROFILE ?? "standard") as HardwareProfile;
  if (!PROFILES[profile]) {
    throw new Error(
      `Unknown profile "${profile}". Valid: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  const profileConfig = PROFILES[profile];

  return {
    profileConfig,
    ollama: {
      baseUrl: process.env.MEDSCI_OLLAMA_URL ?? "http://127.0.0.1:11434",
      defaultModel:
        process.env.MEDSCI_OLLAMA_MODEL ?? profileConfig.reasoningModel,
      timeoutMs: Number(process.env.MEDSCI_OLLAMA_TIMEOUT ?? 120_000),
    },
    python: {
      binary: process.env.MEDSCI_PYTHON ?? "python3",
      timeoutMs: Number(process.env.MEDSCI_PYTHON_TIMEOUT ?? 60_000),
    },
  };
}
