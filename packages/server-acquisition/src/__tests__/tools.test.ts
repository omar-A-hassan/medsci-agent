import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockContext } from "@medsci/core/testing";
import { acquireDocuments } from "../tools/acquire-documents";
import { resolveIdentifierToSources } from "../tools/resolve-identifier-to-sources";
import { __testing as acquireTesting } from "../tools/acquire-documents";
import { acquisitionSidecar } from "../tools/sidecar";

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;
const originalCacheDir = process.env.ACQ_CACHE_DIR;
const originalSidecarCall = acquisitionSidecar.call.bind(acquisitionSidecar);
const originalSidecarIsRunning = acquisitionSidecar.isRunning.bind(acquisitionSidecar);

let cacheDir = "";

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "acq-cache-"));
  process.env.ACQ_CACHE_DIR = cacheDir;
  Bun.sleep = mock(() => Promise.resolve());
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Bun.sleep = originalSleep;
  acquisitionSidecar.call = originalSidecarCall;
  acquisitionSidecar.isRunning = originalSidecarIsRunning;
  mock.restore();

  if (originalCacheDir === undefined) {
    delete process.env.ACQ_CACHE_DIR;
  } else {
    process.env.ACQ_CACHE_DIR = originalCacheDir;
  }

  if (cacheDir) {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

describe("resolve_identifier_to_sources", () => {
  test("resolves DOI with deterministic and idconv candidates", async () => {
    globalThis.fetch = mock((url: string | URL) => {
      const raw = String(url);
      if (raw.includes("idconv")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ records: [{ pmcid: "PMC10410527", pmid: "36856617" }] }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await resolveIdentifierToSources.execute(
      { identifier: "10.1056/NEJMoa1603827" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.normalized.kind).toBe("doi");
    expect(result.data?.sources.some((s) => s.url.includes("doi.org"))).toBe(true);
    expect(result.data?.sources.some((s) => s.url.includes("pmc.ncbi.nlm.nih.gov"))).toBe(true);
  });
});

describe("acquire_documents", () => {
  test("blocks localhost targets via policy", async () => {
    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "http://localhost/secret", source_type: "url" }],
        options: { strict_policy: true, allowlist_tier: "open" },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.blocked).toBe(1);
    expect(result.data?.results[0].status).toBe("blocked");
    expect(result.data?.results[0].policy.blocked).toBe(true);
  });

  test("enforces policy matrix for URL edge-cases", async () => {
    const ctx = createMockContext();
    const targets = [
      "http://user:pass@example.org/paper",
      "https://example.org:444/paper",
      "https://internal.local/thing",
      "http://[::1]/secret",
    ];

    const result = await acquireDocuments.execute(
      {
        targets: targets.map((target) => ({ target, source_type: "url" as const })),
        options: { allowlist_tier: "open", strict_policy: true },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.blocked).toBe(4);
    expect(result.data?.results.every((r) => r.status === "blocked")).toBe(true);
  });

  test("redirect to blocked host is denied", async () => {
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://localhost/secret" },
          }),
        );
      }
      return Promise.resolve(new Response("should not reach", { status: 200 }));
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "https://doi.org/10.1234/test", source_type: "url" }],
        options: { allowlist_tier: "open", strict_policy: true },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.results[0].status).toBe("blocked");
    expect(result.data?.results[0].error_code).toBeDefined();
  });

  test("follows redirects and acquires plain text payload with explicit backend", async () => {
    let calls = 0;
    globalThis.fetch = mock((url: string | URL) => {
      calls++;
      const raw = String(url);
      if (raw.includes("idconv")) {
        return Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200 }));
      }
      if (calls === 2) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://ncbi.nlm.nih.gov/final" },
          }),
        );
      }

      return Promise.resolve(
        new Response("Full body text for testing", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "10.1234/test", source_type: "doi" }],
        options: { allowlist_tier: "strict", strict_policy: true },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.acquired).toBe(1);
    expect(result.data?.results[0]?.document?.text).toContain("Full body text");
    expect(result.data?.results[0]?.document?.extraction_backend).toBe("plain_text");
    expect(result.data?.results[0]?.document?.fallback_used).toBe(false);
  });

  test("uses NCBI BioC full text via PMCID and skips pubmed page scraping", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = mock((url: string | URL) => {
      const raw = String(url);
      seenUrls.push(raw);

      if (raw.includes("idconv")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              records: [{ requested_id: "31452104", pmid: "31452104", pmcid: "PMC7159299" }],
            }),
            { status: 200 },
          ),
        );
      }

      // PMCID BioC endpoint — returns full text (forced full_text by tryAcquireViaNcbiBioc)
      if (raw.includes("/pmcoa.cgi/BioC_json/PMC7159299/unicode")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              documents: [
                {
                  passages: [
                    { text: "Full body text from PMC BioC source." },
                    { text: "Methods and results section." },
                  ],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      if (raw.includes("pubmed.ncbi.nlm.nih.gov/31452104/")) {
        return Promise.resolve(
          new Response("Should not be fetched when BioC full text succeeds", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "31452104", source_type: "pmid" }],
        options: { allowlist_tier: "strict", strict_policy: true },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.acquired).toBe(1);
    expect(result.data?.results[0]?.document?.retrieval_method).toBe("ncbi_bioc");
    expect(result.data?.results[0]?.document?.content_level).toBe("full_text");
    expect(result.data?.results[0]?.document?.text).toContain("Full body text from PMC BioC source");
    // PubMed landing page never fetched — full-text BioC returned immediately
    expect(seenUrls.some((u) => u.includes("pubmed.ncbi.nlm.nih.gov/31452104/"))).toBe(false);
  });

  test("falls through to candidate URLs when BioC returns abstract-only, uses BioC as fallback if all fail", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = mock((url: string | URL) => {
      const raw = String(url);
      seenUrls.push(raw);

      if (raw.includes("idconv")) {
        // No PMCID — only PMID; triggers abstract-only BioC path
        return Promise.resolve(
          new Response(
            JSON.stringify({
              records: [{ requested_id: "31452104", pmid: "31452104" }],
            }),
            { status: 200 },
          ),
        );
      }

      if (raw.includes("/pubmed.cgi/BioC_json/31452104/unicode")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              documents: [{ passages: [{ text: "Abstract-only BioC text." }] }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      // All candidate URLs fail — simulates paywalled/unavailable publisher
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "31452104", source_type: "pmid" }],
        options: { allowlist_tier: "strict", strict_policy: true },
      },
      ctx,
    );

    // Falls back to BioC abstract when all candidates fail
    expect(result.success).toBe(true);
    expect(result.data?.summary.acquired).toBe(1);
    expect(result.data?.results[0]?.document?.retrieval_method).toBe("ncbi_bioc");
    expect(result.data?.results[0]?.document?.content_level).toBe("abstract");
    expect(result.data?.results[0]?.document?.text).toContain("Abstract-only BioC text");
    // Verify the candidate URL WAS attempted before falling back
    expect(seenUrls.some((u) => u.includes("pubmed.ncbi.nlm.nih.gov/31452104/"))).toBe(true);
  });

  test("falls back to Scrapling flow for PMCID when BioC full text is unavailable", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = mock((url: string | URL) => {
      const raw = String(url);
      seenUrls.push(raw);

      if (raw.includes("idconv")) {
        return Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200 }));
      }

      if (raw.includes("/pmcoa.cgi/BioC_json/PMC2222222/unicode")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }

      if (raw.includes("pmc.ncbi.nlm.nih.gov/articles/PMC2222222/")) {
        return Promise.resolve(
          new Response("A".repeat(4500), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "PMC2222222", source_type: "pmcid" }],
        options: { allowlist_tier: "strict", strict_policy: true },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.acquired).toBe(1);
    expect(result.data?.results[0]?.document?.retrieval_method).toBe("scrapling_html");
    expect(result.data?.results[0]?.document?.extraction_backend).toBe("plain_text");
    expect(result.data?.results[0]?.document?.content_level).toBe("full_text");
    expect(seenUrls.some((u) => u.includes("/pmcoa.cgi/BioC_json/PMC2222222/unicode"))).toBe(true);
    expect(seenUrls.some((u) => u.includes("pmc.ncbi.nlm.nih.gov/articles/PMC2222222/"))).toBe(true);
  });

  test("labels scraped PubMed landing content as abstract (not full_text)", async () => {
    globalThis.fetch = mock((url: string | URL) => {
      const raw = String(url);
      if (raw.includes("idconv")) {
        return Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200 }));
      }
      if (raw.includes("/pubmed.cgi/BioC_json/12345678/unicode")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (raw.includes("pubmed.ncbi.nlm.nih.gov/12345678/")) {
        return Promise.resolve(
          new Response("PubMed page chrome ".repeat(350), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "12345678", source_type: "pmid" }],
        options: { allowlist_tier: "strict", strict_policy: true },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.acquired).toBe(1);
    expect(result.data?.results[0]?.document?.retrieval_method).toBe("scrapling_html");
    expect(result.data?.results[0]?.document?.content_level).toBe("abstract");
  });

  test("keeps DOI acquisition Scrapling-primary (no BioC preflight attempt)", async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = mock((url: string | URL) => {
      const raw = String(url);
      seenUrls.push(raw);

      if (raw.includes("idconv")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              records: [{ requested_id: "10.1234/test", pmcid: "PMC12345", pmid: "99999999" }],
            }),
            { status: 200 },
          ),
        );
      }

      if (raw.includes("doi.org/10.1234/test")) {
        return Promise.resolve(
          new Response("DOI text body", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "10.1234/test", source_type: "doi" }],
        options: { allowlist_tier: "strict", strict_policy: true },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.acquired).toBe(1);
    expect(result.data?.results[0]?.document?.retrieval_method).toBe("scrapling_html");
    expect(seenUrls.some((u) => u.includes("/BioC_json/"))).toBe(false);
  });

  test("fails on MIME mismatch", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"x":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "https://pmc.ncbi.nlm.nih.gov/articles/PMC1/", source_type: "url" }],
        options: { allowlist_tier: "strict" },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.results[0].status).toBe("failed");
    expect(result.data?.results[0].error_code).toBe("MIME_NOT_ALLOWED");
  });

  test("fails on oversized payload using content-length header", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("tiny", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": "9999999",
          },
        }),
      ),
    ) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "https://pmc.ncbi.nlm.nih.gov/articles/PMC2/", source_type: "url" }],
        options: { allowlist_tier: "strict", max_bytes: 1000 },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.results[0].status).toBe("failed");
    expect(result.data?.results[0].error_code).toBe("CONTENT_TOO_LARGE");
  });

  test("fails on oversized payload during stream read without content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("X".repeat(800)));
        controller.enqueue(new TextEncoder().encode("Y".repeat(800)));
        controller.close();
      },
    });

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    ) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "https://pmc.ncbi.nlm.nih.gov/articles/PMC2/", source_type: "url" }],
        options: { allowlist_tier: "strict", max_bytes: 1000 },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.results[0].status).toBe("failed");
    expect(result.data?.results[0].error_code).toBe("CONTENT_TOO_LARGE");
  });

  test("returns failure when extraction yields empty text", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("   \n\t   ", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    ) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3/", source_type: "url" }],
        options: { allowlist_tier: "strict" },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.results[0].status).toBe("failed");
    expect(result.data?.results[0].error_code).toBe("EXTRACTION_FAILED");
  });

  test("dedupes duplicate canonical ids in one call", async () => {
    let calls = 0;
    globalThis.fetch = mock((url: string | URL) => {
      calls += 1;
      const raw = String(url);
      if (raw.includes("idconv")) {
        return Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response("Repeated source body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    }) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [
          { target: "10.1056/NEJMoa1603827", source_type: "doi" },
          { target: "https://doi.org/10.1056/NEJMoa1603827", source_type: "doi" },
        ],
        options: { allowlist_tier: "strict" },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.summary.acquired).toBe(2);
    expect(result.data?.results[1]?.document?.retrieval_method).toBe("cached");
    expect(calls).toBeLessThanOrEqual(3);
  });

  test("marks too-many-redirects errors as retryable", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://pmc.ncbi.nlm.nih.gov/articles/PMC-loop/" },
        }),
      ),
    ) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [{ target: "https://pmc.ncbi.nlm.nih.gov/articles/PMC-loop/", source_type: "url" }],
        options: { allowlist_tier: "strict", max_redirects: 1 },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.results[0].status).toBe("failed");
    expect(result.data?.results[0].retryable).toBe(true);
    expect(result.data?.results[0].error_code).toBe("TOO_MANY_REDIRECTS");
  });

  test("semaphore helper enforces concurrency cap", async () => {
    const semaphore = new acquireTesting.Semaphore(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 6 }).map(() =>
        semaphore.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 0));
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  // Edge-case tests (Issue 12A)

  test("redirect loop exceeding max_redirects=2 fails the document but tool succeeds", async () => {
    // Every fetch call returns a 302 redirect back to the same URL, creating
    // an infinite loop that is bounded by max_redirects=2.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9999999/" },
        }),
      ),
    ) as unknown as typeof fetch;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [
          {
            target: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9999999/",
            source_type: "url",
          },
        ],
        options: { allowlist_tier: "strict", strict_policy: true, max_redirects: 2 },
      },
      ctx,
    );

    // The tool itself must succeed — it wraps per-document errors
    expect(result.success).toBe(true);
    // The individual document result must report failure
    expect(result.data?.results[0].status).toBe("failed");
    expect(result.data?.results[0].error_code).toBe("TOO_MANY_REDIRECTS");
    expect(result.data?.results[0].retryable).toBe(true);
    expect(result.data?.summary.acquired).toBe(0);
    expect(result.data?.summary.failed).toBe(1);
  });

  test("deriveContentLevel returns metadata for empty text", () => {
    // The content_level='metadata' sentinel is produced by deriveContentLevel
    // when the text is empty (before the extraction-failed guard).
    // This tests the __testing helper directly since the full acquisition
    // pipeline always throws EXTRACTION_FAILED before persisting empty text.
    expect(acquireTesting.deriveContentLevel("")).toBe("metadata");
    expect(acquireTesting.deriveContentLevel("   \n  ")).toBe("metadata");

    // Short but non-empty text (<2500 chars) yields 'abstract'
    expect(acquireTesting.deriveContentLevel("Short abstract text.")).toBe("abstract");

    // Long text (>=2500 chars) yields 'full_text'
    expect(acquireTesting.deriveContentLevel("A".repeat(2500))).toBe("full_text");
  });

  test("extraction_backend beautifulsoup fallback is propagated into the AcquiredDocument", async () => {
    // Mock fetch to return an HTML response so the sidecar extraction path is reached.
    globalThis.fetch = mock((url: string | URL) => {
      const raw = String(url);
      if (raw.includes("idconv")) {
        return Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          "<html><body><p>Article body text that is long enough for full_text classification.</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      );
    }) as unknown as typeof fetch;

    // Mock the acquisition sidecar to simulate a beautifulsoup fallback response.
    acquisitionSidecar.isRunning = mock(() => true);
    acquisitionSidecar.call = mock(async <T = unknown>(_method: string, _args: unknown) => {
      return {
        text: "Article body text that is long enough for full_text classification.",
        title: "Test Article via BeautifulSoup",
        extraction_confidence: 0.45,
        extraction_backend: "beautifulsoup",
        fallback_used: true,
      } as unknown as T;
    }) as any;

    const ctx = createMockContext();
    const result = await acquireDocuments.execute(
      {
        targets: [
          {
            target: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8888888/",
            source_type: "url",
          },
        ],
        options: {
          allowlist_tier: "strict",
          strict_policy: true,
          require_scrapling: false,
        },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data?.results[0].status).toBe("acquired");
    const doc = result.data?.results[0].document;
    expect(doc?.extraction_backend).toBe("beautifulsoup");
    expect(doc?.fallback_used).toBe(true);
    // BeautifulSoup confidence is 0.45, which is below 0.5
    expect(doc?.extraction_confidence).toBeLessThan(0.5);
    expect(doc?.extraction_confidence).toBe(0.45);
  });
});
