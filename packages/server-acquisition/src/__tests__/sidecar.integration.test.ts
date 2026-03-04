import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const sidecarScript = join(process.cwd(), "packages/server-acquisition/python/acquisition_sidecar.py");
const paperqaPythonCandidates = [
  join(process.cwd(), "packages/server-paperqa/.venv-paperqa/bin/python3"),
  join(process.cwd(), "packages/server-paperqa/.venv-paperqa/bin/python"),
];
const paperqaPython = paperqaPythonCandidates.find((path) => existsSync(path));

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
