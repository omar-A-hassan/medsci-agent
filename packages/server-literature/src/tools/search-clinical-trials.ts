import { defineTool, interpretWithMedGemma } from "@medsci/core";
import { resilientFetch } from "@medsci/core/src/utils";
import { z } from "zod";

const CT_BASE = "https://clinicaltrials.gov/api/v2";

export const searchClinicalTrials = defineTool({
	name: "search_clinical_trials",
	description:
		"Search ClinicalTrials.gov for clinical studies by condition, drug, or intervention. Returns trial status, phase, enrollment, and study details.",
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
		needs_synthesized_summary: z
			.boolean()
			.optional()
			.default(true)
			.describe(
				"Set to false to bypass MedGemma context summarization and return raw data",
			),
	}),
	execute: async (input, ctx) => {
		const pageSize = input.max_results ?? 10;

		let url = `${CT_BASE}/studies?query.term=${encodeURIComponent(input.query)}&pageSize=${pageSize}&format=json`;
		if (input.status && input.status !== "ANY") {
			url += `&filter.overallStatus=${input.status}`;
		}

		const res = await resilientFetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
			maxRetries: 3,
		});

		if (!res.ok) {
			return {
				success: false,
				error: `ClinicalTrials.gov API returned ${res.status}`,
			};
		}

		const json = (await res.json()) as any;
		const studies = json.studies ?? [];

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
		};

		if (!input.needs_synthesized_summary) {
			return {
				success: true,
				data: { ...trialData, interpretation: "", model_used: false },
			};
		}

		const { interpretation, model_used } = await interpretWithMedGemma(
			ctx,
			results,
			`Summarize the clinical trial landscape for "${input.query}". ` +
				"What phases are most represented? Any notable trends in study design or endpoints?",
		);

		return {
			success: true,
			data: { ...trialData, interpretation, model_used },
		};
	},
});
