import type { InterpretResult } from "./interpret";

export interface OptionalSynthesisResult {
	interpretation: string;
	model_used: boolean;
}

export async function withOptionalSynthesis<T extends object>(
	needsSynthesis: boolean,
	rawData: T,
	summarize: () => Promise<InterpretResult>,
): Promise<T & OptionalSynthesisResult> {
	if (!needsSynthesis) {
		return {
			...rawData,
			interpretation: "",
			model_used: false,
		};
	}

	const { interpretation, model_used } = await summarize();
	return {
		...rawData,
		interpretation,
		model_used,
	};
}
