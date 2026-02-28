import type {
	ClassifyResult,
	GenerateOpts,
	OllamaClientInterface,
} from "../types";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "medgemma:latest";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Thin adapter for the Ollama REST API.
 * Handles text generation, embeddings, and classification-via-prompt.
 */
export class OllamaClient implements OllamaClientInterface {
	private baseUrl: string;
	private defaultModel: string;
	private timeoutMs: number;

	constructor(opts?: {
		baseUrl?: string;
		defaultModel?: string;
		timeoutMs?: number;
	}) {
		this.baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
		this.defaultModel = opts?.defaultModel ?? DEFAULT_MODEL;
		this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(5_000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	async generate(prompt: string, opts?: GenerateOpts): Promise<string> {
		const model = opts?.model ?? this.defaultModel;

		const body: Record<string, unknown> = {
			model,
			prompt,
			stream: false,
			options: {
				temperature: opts?.temperature ?? 0.3,
				num_predict: opts?.maxTokens ?? 2048,
			},
		};
		if (opts?.system) {
			body.system = opts.system;
		}
		if (opts?.images?.length) {
			body.images = opts.images;
		}

		const res = await fetch(`${this.baseUrl}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Ollama generate failed (${res.status}): ${text || res.statusText}`,
			);
		}

		const json = (await res.json()) as { response: string };
		return json.response;
	}

	/**
	 * Generate and parse a JSON response from the model.
	 * Strips markdown code fences that models often wrap around JSON output.
	 */
	async generateJson<T = unknown>(
		prompt: string,
		opts?: GenerateOpts,
	): Promise<T> {
		const raw = await this.generate(prompt, opts);
		const cleaned = raw
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/i, "")
			.trim();
		return JSON.parse(cleaned) as T;
	}

	/** @reserved — not yet used by any tool; kept for future semantic search */
	async embed(text: string, model?: string): Promise<number[]> {
		const res = await fetch(`${this.baseUrl}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: model ?? this.defaultModel,
				input: text,
			}),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			throw new Error(
				`Ollama embed failed (${res.status}): ${errText || res.statusText}`,
			);
		}

		const json = (await res.json()) as { embeddings: number[][] };
		return json.embeddings[0];
	}

	/**
	 * @reserved — not yet used by any tool; kept for future classification pipelines.
	 * Classification via constrained prompting.
	 * Asks the model to pick one label and return a confidence score.
	 */
	async classify(prompt: string, labels: string[]): Promise<ClassifyResult> {
		const system = [
			"You are a classification model. Given the input, respond ONLY with valid JSON.",
			`Choose exactly one label from: ${JSON.stringify(labels)}.`,
			'Format: {"label":"chosen_label","score":0.95}',
			"score is your confidence between 0 and 1.",
		].join(" ");

		try {
			const parsed = await this.generateJson<{
				label: string;
				score: number;
			}>(prompt, {
				system,
				temperature: 0.1,
				maxTokens: 100,
			});
			if (!labels.includes(parsed.label)) {
				throw new Error(`Model returned unknown label: ${parsed.label}`);
			}
			return {
				label: parsed.label,
				score: parsed.score,
				allScores: { [parsed.label]: parsed.score },
			};
		} catch (err) {
			// Fallback: try to find a label in the raw text
			const raw = await this.generate(prompt, {
				system,
				temperature: 0.1,
				maxTokens: 100,
			});
			const found = labels.find((l) =>
				raw.toLowerCase().includes(l.toLowerCase()),
			);
			return {
				label: found ?? labels[0],
				score: found ? 0.5 : 0.1,
				allScores: Object.fromEntries(
					labels.map((l) => [l, l === found ? 0.5 : 0.1]),
				),
			};
		}
	}
}
