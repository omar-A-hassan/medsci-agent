import { test, expect, mock, describe, beforeEach } from "bun:test";
import { z } from "zod";
import { defineTool } from "../tool-factory";
import type { ToolContext } from "../types";

// --- Mock context factory ---
function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    ollama: {
      generate: mock(() => Promise.resolve("mock response")),
      generateJson: mock(() => Promise.resolve({ mock: true })),
      embed: mock(() => Promise.resolve([0.1, 0.2, 0.3])),
      classify: mock(() =>
        Promise.resolve({ label: "positive", score: 0.9, allScores: { positive: 0.9 } }),
      ),
      isAvailable: mock(() => Promise.resolve(true)),
    },
    python: {
      call: mock(() => Promise.resolve({ result: "mock" })),
      isRunning: () => true,
      start: mock(() => Promise.resolve()),
      stop: mock(() => Promise.resolve()),
    },
    log: {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    },
    ...overrides,
  };
}

// --- Test tool ---
const echoTool = defineTool({
  name: "echo",
  description: "Echoes back the input",
  schema: z.object({
    message: z.string().min(1),
  }),
  execute: async (input) => ({
    success: true,
    data: { echoed: input.message },
  }),
});

const failingTool = defineTool({
  name: "always_fail",
  description: "Always throws",
  schema: z.object({ input: z.string() }),
  execute: async () => {
    throw new Error("Intentional failure");
  },
});

// --- Tests ---
describe("defineTool", () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  test("executes successfully with valid input", async () => {
    const result = await echoTool.execute({ message: "hello" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ echoed: "hello" });
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  test("returns validation error for invalid input", async () => {
    const result = await echoTool.execute({ message: "" } as any, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid input");
    expect(result.error).toContain("message");
  });

  test("returns validation error for missing required fields", async () => {
    const result = await echoTool.execute({} as any, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid input");
  });

  test("returns validation error for wrong type", async () => {
    const result = await echoTool.execute({ message: 123 } as any, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid input");
  });

  test("catches and wraps execution errors", async () => {
    const result = await failingTool.execute({ input: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Intentional failure");
    expect(result.duration_ms).toBeGreaterThan(0);
  });

  test("logs execution start and success", async () => {
    await echoTool.execute({ message: "hello" }, ctx);
    expect(ctx.log.info).toHaveBeenCalledTimes(2); // start + complete
  });

  test("logs execution start and failure", async () => {
    await failingTool.execute({ input: "test" }, ctx);
    expect(ctx.log.info).toHaveBeenCalledTimes(1); // start only
    expect(ctx.log.error).toHaveBeenCalledTimes(1); // failure
  });

  test("logs validation warnings", async () => {
    await echoTool.execute({} as any, ctx);
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
  });

  test("tracks duration on all paths", async () => {
    const success = await echoTool.execute({ message: "hi" }, ctx);
    const failure = await failingTool.execute({ input: "x" }, ctx);
    const invalid = await echoTool.execute({} as any, ctx);

    expect(success.duration_ms).toBeDefined();
    expect(failure.duration_ms).toBeDefined();
    expect(invalid.duration_ms).toBeDefined();
  });

  test("preserves tool metadata", () => {
    expect(echoTool.name).toBe("echo");
    expect(echoTool.description).toBe("Echoes back the input");
  });
});

// --- Edge cases ---
describe("defineTool edge cases", () => {
  test("handles non-Error throws", async () => {
    const tool = defineTool({
      name: "string_throw",
      description: "Throws a string",
      schema: z.object({ x: z.string() }),
      execute: async () => {
        throw "string error";
      },
    });
    const ctx = createMockContext();
    const result = await tool.execute({ x: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("string error");
  });

  test("handles async timeout-like errors", async () => {
    const tool = defineTool({
      name: "timeout_sim",
      description: "Simulates timeout",
      schema: z.object({ x: z.string() }),
      execute: async () => {
        throw new Error("AbortError: The operation was aborted");
      },
    });
    const ctx = createMockContext();
    const result = await tool.execute({ x: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("aborted");
  });

  test("handles tool with optional fields", async () => {
    const tool = defineTool({
      name: "optional_fields",
      description: "Has optional fields",
      schema: z.object({
        required: z.string(),
        optional: z.string().optional(),
      }),
      execute: async (input) => ({
        success: true,
        data: { got: input.required, opt: input.optional },
      }),
    });
    const ctx = createMockContext();

    const withOpt = await tool.execute({ required: "a", optional: "b" }, ctx);
    expect(withOpt.success).toBe(true);
    expect(withOpt.data).toEqual({ got: "a", opt: "b" });

    const withoutOpt = await tool.execute({ required: "a" } as any, ctx);
    expect(withoutOpt.success).toBe(true);
    expect(withoutOpt.data).toEqual({ got: "a", opt: undefined });
  });
});
