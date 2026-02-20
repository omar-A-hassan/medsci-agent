import { test, expect, describe, mock, afterEach } from "bun:test";
import type { ToolContext } from "@medsci/core";
import { analyzeMedicalImage } from "../tools/analyze-medical-image";

// We need to mock fs/promises for stat and readFile
const mockStat = mock(() => Promise.resolve({ size: 1024 }));
const mockReadFile = mock(() => Promise.resolve(Buffer.from("fake-image-data")));

// Bun module mocking via mock.module
mock.module("node:fs/promises", () => ({
  stat: mockStat,
  readFile: mockReadFile,
}));

function createMockContext(): ToolContext {
  return {
    ollama: {
      generate: mock(() => Promise.resolve("Raw text findings.")),
      generateJson: mock(() =>
        Promise.resolve({
          findings: ["Normal cardiac silhouette"],
          impression: "No acute cardiopulmonary abnormality",
          recommendations: ["No follow-up needed"],
          disclaimer: "AI-assisted analysis.",
        }),
      ),
      embed: mock(() => Promise.resolve([])),
      classify: mock(() =>
        Promise.resolve({ label: "ok", score: 0.9, allScores: {} }),
      ),
      isAvailable: mock(() => Promise.resolve(true)),
    },
    python: {
      call: mock(() => Promise.resolve({})),
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
  };
}

describe("analyze_medical_image", () => {
  afterEach(() => {
    mockStat.mockReset();
    mockReadFile.mockReset();
    mockStat.mockImplementation(() => Promise.resolve({ size: 1024 }));
    mockReadFile.mockImplementation(() => Promise.resolve(Buffer.from("fake-image")));
  });

  test("returns analysis with model_used=true on success", async () => {
    const ctx = createMockContext();
    const result = await analyzeMedicalImage.execute(
      { image_path: "/tmp/xray.png", modality: "chest_xray" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.modality).toBe("chest_xray");
    expect(result.data?.analysis).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("passes images array to generateJson", async () => {
    const ctx = createMockContext();
    await analyzeMedicalImage.execute(
      { image_path: "/tmp/xray.png", modality: "chest_xray" },
      ctx,
    );
    const call = (ctx.ollama.generateJson as any).mock.calls[0];
    expect(call[1].images).toBeDefined();
    expect(call[1].images.length).toBe(1);
  });

  test("includes clinical context in prompt", async () => {
    const ctx = createMockContext();
    await analyzeMedicalImage.execute(
      {
        image_path: "/tmp/xray.png",
        modality: "chest_xray",
        clinical_context: "rule out pneumonia",
      },
      ctx,
    );
    const prompt = (ctx.ollama.generateJson as any).mock.calls[0][0];
    expect(prompt).toContain("rule out pneumonia");
  });

  test("rejects files over 50MB", async () => {
    mockStat.mockImplementation(() =>
      Promise.resolve({ size: 60 * 1024 * 1024 }),
    );
    const ctx = createMockContext();
    const result = await analyzeMedicalImage.execute(
      { image_path: "/tmp/huge.png", modality: "other" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
  });

  test("returns error when file does not exist", async () => {
    mockStat.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const ctx = createMockContext();
    const result = await analyzeMedicalImage.execute(
      { image_path: "/tmp/missing.png", modality: "other" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not access");
  });

  test("handles model_used=false when both generate calls fail", async () => {
    const ctx = createMockContext();
    (ctx.ollama.generateJson as any).mockImplementation(() => {
      throw new Error("parse error");
    });
    (ctx.ollama.generate as any).mockImplementation(() => {
      throw new Error("Ollama down");
    });
    const result = await analyzeMedicalImage.execute(
      { image_path: "/tmp/xray.png", modality: "chest_xray" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.model_used).toBe(false);
    expect(result.data?.analysis.impression).toBe("MedGemma unavailable");
  });
});
