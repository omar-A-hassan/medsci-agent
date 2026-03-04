import { defineTool } from "@medsci/core";
import { z } from "zod";
import {
  applyOptionalSynthesis,
  fetchJsonOrError,
  needsSynthesizedSummaryField,
} from "./shared";

const CT_BASE = "https://clinicaltrials.gov/api/v2";

export const searchClinicalTrials = defineTool({
  name: "search_clinical_trials",
  description:
    "Search ClinicalTrials.gov study metadata by condition, intervention, or NCT identifier.",
  schema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Search query: condition name, drug name, or NCT number"),
    status: z
      .enum(["RECRUITING", "COMPLETED", "ACTIVE_NOT_RECRUITING", "ANY"])
      .optional()
      .describe("Filter by trial status (default: ANY)"),
    max_results: z
      .number()
      .int()
      .positive()
      .max(25)
      .optional()
      .describe("Max results (default: 10)"),
    needs_synthesized_summary: needsSynthesizedSummaryField,
  }),
  execute: async (input, ctx) => {
    const pageSize = input.max_results ?? 10;

    let url = `${CT_BASE}/studies?query.term=${encodeURIComponent(input.query)}&pageSize=${pageSize}&format=json`;
    if (input.status && input.status !== "ANY") {
      url += `&filter.overallStatus=${input.status}`;
    }

    const response = await fetchJsonOrError<any>(
      url,
      "ClinicalTrials.gov API returned",
      {
        timeoutMs: 15_000,
        headers: { Accept: "application/json" },
      },
    );

    if (!response.ok) {
      return {
        success: false,
        error: response.error,
      };
    }

    const studies = response.data.studies ?? [];
    const results = studies.map((study: any) => {
      const protocol = study.protocolSection;
      const ident = protocol?.identificationModule;
      const status = protocol?.statusModule;
      const design = protocol?.designModule;
      const desc = protocol?.descriptionModule;

      return {
        nct_id: ident?.nctId,
        title: ident?.briefTitle,
        status: status?.overallStatus,
        phase: design?.phases?.join(", "),
        enrollment: design?.enrollmentInfo?.count,
        start_date: status?.startDateStruct?.date,
        brief_summary: desc?.briefSummary?.slice(0, 300),
      };
    });

    const trialData = {
      query: input.query,
      n_results: results.length,
      results,
      content_level: "metadata",
    };

    const data = await applyOptionalSynthesis(
      ctx,
      input.needs_synthesized_summary ?? true,
      trialData,
      results,
      `Summarize the trial landscape for "${input.query}" from these ClinicalTrials.gov metadata results. ` +
        "Focus on represented phases, recruitment status, and notable design patterns.",
    );

    return {
      success: true,
      data,
    };
  },
});
