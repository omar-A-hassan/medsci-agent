import {
  interpretWithMedGemma,
  normalizeDoi as normalizeDoiCore,
  resilientFetch,
  withOptionalSynthesis,
  type ToolContext,
} from "@medsci/core";
import { z } from "zod";

export const needsSynthesizedSummaryField = z
  .boolean()
  .optional()
  .default(true)
  .describe("Set to false to bypass MedGemma context summarization and return raw data");

export async function fetchJsonOrError<T>(
  url: string,
  errorPrefix: string,
  opts?: {
    timeoutMs?: number;
    headers?: Record<string, string>;
  },
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const response = await resilientFetch(url, {
    headers: opts?.headers,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000),
    maxRetries: 3,
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `${errorPrefix}: ${response.status}`,
    };
  }

  return {
    ok: true,
    data: (await response.json()) as T,
  };
}

export async function fetchTextOrError(
  url: string,
  errorPrefix: string,
  timeoutMs = 15_000,
): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
  const response = await resilientFetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    maxRetries: 3,
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `${errorPrefix}: ${response.status}`,
    };
  }

  return {
    ok: true,
    data: await response.text(),
  };
}

export async function applyOptionalSynthesis<T extends object>(
  ctx: ToolContext,
  enabled: boolean,
  rawData: T,
  llmInput: unknown,
  synthesisPrompt: string,
): Promise<any> {
  return withOptionalSynthesis(enabled, rawData, () =>
    interpretWithMedGemma(ctx, llmInput, synthesisPrompt),
  );
}

export function normalizeDoi(raw: string | undefined | null): string | undefined {
  return normalizeDoiCore(raw);
}

export function extractPubmedDoi(article: any): string | undefined {
  const fromArticleIds = Array.isArray(article?.articleids)
    ? article.articleids.find(
        (item: any) =>
          String(item?.idtype || "").toLowerCase() === "doi" &&
          typeof item?.value === "string",
      )?.value
    : undefined;

  const fromElocation =
    typeof article?.elocationid === "string" ? article.elocationid : undefined;

  return normalizeDoi(fromArticleIds) ?? normalizeDoi(fromElocation);
}
