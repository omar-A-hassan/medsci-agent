import { defineTool } from "@medsci/core";
import { z } from "zod";
import { normalizeTarget, resolveCandidates } from "./resolver";

export const resolveIdentifierToSources = defineTool({
  name: "resolve_identifier_to_sources",
  description:
    "Resolve a DOI/PMID/PMCID to candidate source URLs with provenance and confidence metadata.",
  schema: z.object({
    identifier: z
      .string()
      .min(1)
      .describe("DOI, PMID, PMCID, or URL to resolve into candidate sources"),
    source_type: z
      .enum(["doi", "pmid", "pmcid", "url"])
      .optional()
      .describe("Optional source type hint"),
  }),
  execute: async (input) => {
    const normalized = normalizeTarget(input.identifier, input.source_type);
    const resolved = await resolveCandidates(normalized);
    return {
      success: true,
      data: {
        identifier: input.identifier,
        normalized,
        sources: resolved.candidates,
      },
    };
  },
});
