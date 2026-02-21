import { test, expect, describe } from "bun:test";
import { interpretWithMedGemma } from "../interpret";
import { createMockContext } from "./test-helpers";

describe("interpretWithMedGemma", () => {
  test("returns interpretation and model_used=true on success", async () => {
    const ctx = createMockContext({ generateResponse: "These genes suggest immune activation." });

    const result = await interpretWithMedGemma(
      ctx,
      { gene: "CD8A", logfoldchange: 2.5 },
      "Interpret these DE genes.",
    );

    expect(result.interpretation).toBe("These genes suggest immune activation.");
    expect(result.model_used).toBe(true);
  });

  test("passes data as JSON string in prompt", async () => {
    const ctx = createMockContext();
    (ctx.ollama.generate as any).mockImplementation((prompt: string) => {
      expect(prompt).toContain('"gene"');
      expect(prompt).toContain("TP53");
      return Promise.resolve("TP53 is a tumor suppressor.");
    });

    await interpretWithMedGemma(ctx, { gene: "TP53" }, "Analyze this.");
    expect(ctx.ollama.generate).toHaveBeenCalled();
  });

  test("passes string data directly without JSON.stringify", async () => {
    const ctx = createMockContext();
    (ctx.ollama.generate as any).mockImplementation((prompt: string) => {
      expect(prompt).toContain("raw text data here");
      return Promise.resolve("Analysis complete.");
    });

    await interpretWithMedGemma(ctx, "raw text data here", "Analyze this.");
  });

  test("passes system prompt and options to generate", async () => {
    const ctx = createMockContext();
    (ctx.ollama.generate as any).mockImplementation((_prompt: string, opts: any) => {
      expect(opts.system).toContain("MedGemma");
      expect(opts.temperature).toBe(0.2);
      expect(opts.maxTokens).toBe(200);
      return Promise.resolve("ok");
    });

    await interpretWithMedGemma(ctx, {}, "Test", {
      temperature: 0.2,
      maxTokens: 200,
    });
  });

  test("uses default temperature=0.3 and maxTokens=400", async () => {
    const ctx = createMockContext();
    (ctx.ollama.generate as any).mockImplementation((_prompt: string, opts: any) => {
      expect(opts.temperature).toBe(0.3);
      expect(opts.maxTokens).toBe(400);
      return Promise.resolve("ok");
    });

    await interpretWithMedGemma(ctx, {}, "Test");
  });

  test("returns model_used=false when generate throws", async () => {
    const ctx = createMockContext();
    (ctx.ollama.generate as any).mockImplementation(() => {
      throw new Error("Ollama connection refused");
    });

    const result = await interpretWithMedGemma(ctx, {}, "Test");
    expect(result.interpretation).toBe("");
    expect(result.model_used).toBe(false);
  });

  test("returns model_used=false when generate returns empty string", async () => {
    const ctx = createMockContext({ generateResponse: "   " });

    const result = await interpretWithMedGemma(ctx, {}, "Test");
    expect(result.interpretation).toBe("");
    expect(result.model_used).toBe(false);
  });

  test("trims whitespace from interpretation", async () => {
    const ctx = createMockContext({ generateResponse: "  \n  Trimmed result.  \n  " });

    const result = await interpretWithMedGemma(ctx, {}, "Test");
    expect(result.interpretation).toBe("Trimmed result.");
  });

  test("repeats prompt for improved non-reasoning accuracy (arXiv:2512.14982)", async () => {
    let capturedPrompt = "";
    const ctx = createMockContext();
    (ctx.ollama.generate as any).mockImplementation((prompt: string) => {
      capturedPrompt = prompt;
      return Promise.resolve("ok");
    });

    await interpretWithMedGemma(ctx, { x: 1 }, "Analyze this gene.");

    // Prompt should appear twice — once before data, once after
    const firstIdx = capturedPrompt.indexOf("Analyze this gene.");
    const lastIdx = capturedPrompt.lastIndexOf("Analyze this gene.");
    expect(firstIdx).not.toBe(-1);
    expect(lastIdx).not.toBe(-1);
    expect(lastIdx).toBeGreaterThan(firstIdx);
    // "To reiterate:" separator should be present
    expect(capturedPrompt).toContain("To reiterate:");
  });
});
