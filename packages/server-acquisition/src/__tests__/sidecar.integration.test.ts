import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { acquisitionSidecar, extractHtmlText } from "../tools/sidecar";

const sidecarScript = join(process.cwd(), "packages/server-acquisition/python/acquisition_sidecar.py");
const paperqaPythonCandidates = [
  join(process.cwd(), "packages/server-paperqa/.venv-paperqa/bin/python3"),
  join(process.cwd(), "packages/server-paperqa/.venv-paperqa/bin/python"),
];
const paperqaPython = paperqaPythonCandidates.find((path) => existsSync(path));

if (!paperqaPython) {
  console.warn(
    "Scrapling not installed — HTML extraction quality tests skipped. Install scrapling for full coverage.",
  );
}

function runSidecar(
  pythonBin: string,
  request: Record<string, unknown>,
  opts?: { extraArgs?: string[]; env?: Record<string, string> },
): Record<string, unknown> {
  const output = execFileSync(
    pythonBin,
    [...(opts?.extraArgs ?? []), sidecarScript],
    {
      input: JSON.stringify(request) + "\n",
      encoding: "utf-8",
      env: {
        ...process.env,
        ...(opts?.env ?? {}),
      },
    },
  );
  const lastLine = output.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("acquisition sidecar integration", () => {
  (paperqaPython ? test : test.skip)(
    "health check succeeds with Scrapling available in paperqa venv",
    () => {
      const response = runSidecar(paperqaPython!, {
        id: "h1",
        method: "__health__",
        args: {},
      });
      const result = response.result as Record<string, unknown>;
      expect(result?.status).toBe("ok");
      expect(result?.has_scrapling).toBe(true);
    },
  );

  (paperqaPython ? test : test.skip)(
    "extract_html reports scrapling backend when require_scrapling=true",
    () => {
      const response = runSidecar(paperqaPython!, {
        id: "x1",
        method: "extract_html",
        args: {
          url: "https://example.org",
          html: "<html><head><title>T</title></head><body><p>Hello world</p></body></html>",
          require_scrapling: true,
        },
      });
      const result = response.result as Record<string, unknown>;
      expect(typeof result?.text).toBe("string");
      expect(result?.extraction_backend).toBe("scrapling");
      expect(result?.fallback_used).toBe(false);
    },
  );

  (paperqaPython ? test : test.skip)(
    "fails deterministically when scrapling is required but site-packages are disabled",
    () => {
      const response = runSidecar(
        paperqaPython!,
        {
          id: "h2",
          method: "__health__",
          args: {},
        },
        {
          extraArgs: ["-S"],
          env: { ACQ_REQUIRE_SCRAPLING: "true" },
        },
      );
      expect(String(response.error)).toContain("SCRAPLING_REQUIRED");
    },
  );

  (paperqaPython ? test : test.skip)(
    "falls back explicitly when require_scrapling=false and site-packages are disabled",
    () => {
      const response = runSidecar(
        paperqaPython!,
        {
          id: "x2",
          method: "extract_html",
          args: {
            url: "https://example.org",
            html: "<html><head><title>T</title></head><body><p>Hello fallback</p></body></html>",
            require_scrapling: false,
          },
        },
        {
          extraArgs: ["-S"],
          env: { ACQ_REQUIRE_SCRAPLING: "false" },
        },
      );
      const result = response.result as Record<string, unknown>;
      expect(typeof result?.text).toBe("string");
      expect(result?.fallback_used).toBe(true);
      expect(result?.extraction_backend === "regex" || result?.extraction_backend === "beautifulsoup").toBe(true);
    },
  );
});

describe("extractHtmlText TypeScript fallback chain (no scrapling required)", () => {
  // This test does NOT require scrapling to be installed.
  // It mocks the acquisitionSidecar.call at the TypeScript level and verifies
  // that the extractHtmlText wrapper correctly propagates beautifulsoup fallback
  // fields when the sidecar reports that beautifulsoup was used.

  const originalCall = acquisitionSidecar.call.bind(acquisitionSidecar);
  const originalIsRunning = acquisitionSidecar.isRunning.bind(acquisitionSidecar);

  afterEach(() => {
    acquisitionSidecar.call = originalCall;
    acquisitionSidecar.isRunning = originalIsRunning;
    mock.restore();
  });

  test("propagates extraction_backend=beautifulsoup and fallback_used=true from sidecar response", async () => {
    acquisitionSidecar.isRunning = mock(() => true);
    acquisitionSidecar.call = mock(async <T = unknown>(_method: string, _args: unknown) => {
      return {
        text: "Extracted body text via BeautifulSoup fallback.",
        title: "Test Article",
        extraction_confidence: 0.45,
        extraction_backend: "beautifulsoup",
        fallback_used: true,
      } as unknown as T;
    }) as any;

    const result = await extractHtmlText(
      "<html><body><p>Test content</p></body></html>",
      "https://example.org/article",
      false,
    );

    expect(result.extraction_backend).toBe("beautifulsoup");
    expect(result.fallback_used).toBe(true);
    expect(result.extraction_confidence).toBe(0.45);
    expect(result.text).toContain("BeautifulSoup fallback");
    expect(result.retrieval_method).toBe("scrapling_html");
  });
});
