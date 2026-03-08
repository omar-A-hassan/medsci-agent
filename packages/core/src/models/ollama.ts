import type {
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

}
