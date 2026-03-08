import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { OllamaClient } from "../models/ollama";

// --- Mock fetch ---
const originalFetch = globalThis.fetch;

function mockFetch(
	handler: (url: string, opts?: any) => Response | Promise<Response>,
) {
	globalThis.fetch = mock(handler as any) as any;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("OllamaClient", () => {
	let client: OllamaClient;

	beforeEach(() => {
		client = new OllamaClient({
			baseUrl: "http://127.0.0.1:11434",
			defaultModel: "medgemma:4b",
			timeoutMs: 5000,
		});
	});

	describe("isAvailable", () => {
		test("returns true when Ollama responds", async () => {
			mockFetch(
				() => new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);
			expect(await client.isAvailable()).toBe(true);
		});

		test("returns false when Ollama is down", async () => {
			mockFetch(() => {
				throw new Error("Connection refused");
			});
			expect(await client.isAvailable()).toBe(false);
		});

		test("returns false on non-200 response", async () => {
			mockFetch(() => new Response("error", { status: 500 }));
			expect(await client.isAvailable()).toBe(false);
		});
	});

	describe("generate", () => {
		test("returns generated text", async () => {
			mockFetch(
				() =>
					new Response(
						JSON.stringify({ response: "Diabetes is a metabolic disorder." }),
					),
			);
			const result = await client.generate("What is diabetes?");
			expect(result).toBe("Diabetes is a metabolic disorder.");
		});

		test("sends correct request body", async () => {
			mockFetch((url: string, opts: any) => {
				const body = JSON.parse(opts.body);
				expect(body.model).toBe("medgemma:4b");
				expect(body.prompt).toBe("test prompt");
				expect(body.stream).toBe(false);
				return new Response(JSON.stringify({ response: "ok" }));
			});
			await client.generate("test prompt");
		});

		test("uses custom model when specified", async () => {
			mockFetch((url: string, opts: any) => {
				const body = JSON.parse(opts.body);
				expect(body.model).toBe("txgemma:2b");
				return new Response(JSON.stringify({ response: "ok" }));
			});
			await client.generate("test", { model: "txgemma:2b" });
		});

		test("includes system prompt when provided", async () => {
			mockFetch((url: string, opts: any) => {
				const body = JSON.parse(opts.body);
				expect(body.system).toBe("You are a chemist.");
				return new Response(JSON.stringify({ response: "ok" }));
			});
			await client.generate("test", { system: "You are a chemist." });
		});

		test("throws on non-200 response", async () => {
			mockFetch(() => new Response("Model not found", { status: 404 }));
			expect(client.generate("test")).rejects.toThrow(
				"Ollama generate failed (404)",
			);
		});
	});

	describe("generate with images", () => {
		test("includes images array in request body", async () => {
			mockFetch((url: string, opts: any) => {
				const body = JSON.parse(opts.body);
				expect(body.images).toEqual(["base64data"]);
				return new Response(
					JSON.stringify({ response: "I see a chest X-ray" }),
				);
			});
			const result = await client.generate("Analyze this image", {
				images: ["base64data"],
			});
			expect(result).toBe("I see a chest X-ray");
		});

		test("omits images field when not provided", async () => {
			mockFetch((url: string, opts: any) => {
				const body = JSON.parse(opts.body);
				expect(body.images).toBeUndefined();
				return new Response(JSON.stringify({ response: "ok" }));
			});
			await client.generate("test");
		});
	});

	describe("generateJson", () => {
		test("parses clean JSON response", async () => {
			mockFetch(
				() =>
					new Response(
						JSON.stringify({ response: '{"key":"value","num":42}' }),
					),
			);
			const result = await client.generateJson<{ key: string; num: number }>(
				"test",
			);
			expect(result).toEqual({ key: "value", num: 42 });
		});

		test("strips ```json code fences", async () => {
			mockFetch(
				() =>
					new Response(
						JSON.stringify({ response: '```json\n{"key":"value"}\n```' }),
					),
			);
			const result = await client.generateJson<{ key: string }>("test");
			expect(result).toEqual({ key: "value" });
		});

		test("strips ``` code fences without json tag", async () => {
			mockFetch(
				() =>
					new Response(
						JSON.stringify({ response: '```\n{"key":"value"}\n```' }),
					),
			);
			const result = await client.generateJson<{ key: string }>("test");
			expect(result).toEqual({ key: "value" });
		});

		test("handles leading/trailing whitespace around fences", async () => {
			mockFetch(
				() =>
					new Response(
						JSON.stringify({ response: '  \n```json\n{"a":1}\n```\n  ' }),
					),
			);
			const result = await client.generateJson<{ a: number }>("test");
			expect(result).toEqual({ a: 1 });
		});

		test("throws on unparseable response", async () => {
			mockFetch(
				() =>
					new Response(JSON.stringify({ response: "This is not JSON at all" })),
			);
			expect(client.generateJson("test")).rejects.toThrow();
		});

		test("passes options through to generate", async () => {
			mockFetch((url: string, opts: any) => {
				const body = JSON.parse(opts.body);
				expect(body.system).toBe("Be a chemist");
				expect(body.images).toEqual(["img"]);
				return new Response(JSON.stringify({ response: '{"ok":true}' }));
			});
			await client.generateJson("test", {
				system: "Be a chemist",
				images: ["img"],
			});
		});
	});

});
