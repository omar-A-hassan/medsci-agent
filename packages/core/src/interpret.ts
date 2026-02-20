import type { ToolContext } from "./types";

const MEDGEMMA_SYSTEM_PROMPT =
  "You are MedGemma, a biomedical research AI. " +
  "Provide concise, scientifically accurate interpretations. " +
  "Focus on clinical and biological significance. " +
  "Be specific about mechanisms, pathways, and implications.";

export interface InterpretResult {
  interpretation: string;
  model_used: boolean;
}

/**
 * Pipes structured tool output through MedGemma for domain-specific interpretation.
 * Returns both the interpretation text and a flag indicating whether the model was used.
 * On any failure (Ollama down, timeout, bad response), returns empty interpretation
 * with model_used=false — the caller should still return the raw data.
 */
export async function interpretWithMedGemma(
  ctx: ToolContext,
  data: unknown,
  prompt: string,
  opts?: { maxTokens?: number; temperature?: number },
): Promise<InterpretResult> {
  try {
    const dataStr =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);

    // Prompt repetition: repeating the instruction after the data improves
    // non-reasoning model accuracy (Leviathan et al., 2025 — arXiv:2512.14982).
    // Every token in the first copy can attend to the full context in the second.
    const fullPrompt = `${prompt}\n\nData:\n${dataStr}\n\nTo reiterate:\n${prompt}`;

    const result = await ctx.ollama.generate(fullPrompt, {
      system: MEDGEMMA_SYSTEM_PROMPT,
      temperature: opts?.temperature ?? 0.3,
      maxTokens: opts?.maxTokens ?? 400,
    });

    const trimmed = result.trim();
    if (!trimmed) {
      return { interpretation: "", model_used: false };
    }

    return { interpretation: trimmed, model_used: true };
  } catch {
    return { interpretation: "", model_used: false };
  }
}
