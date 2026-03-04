import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AcquiredDocument,
  AcquisitionExtractionBackend,
  AcquisitionLicenseHint,
  AcquisitionSourceType,
} from "@medsci/core";
import { defineTool, normalizeDoi } from "@medsci/core";
import { z } from "zod";
import {
  AcquisitionError,
  AcquisitionErrorCodes,
  buildAcquiredResult,
  buildBlockedResult,
  buildFailedResult,
  toAcquisitionError,
  type AcquisitionResultRecord,
} from "./errors";
import {
  evaluateUrlPolicy,
  evaluateUrlPolicyWithDns,
  type AllowlistTier,
} from "./policy";
import {
  normalizeTarget,
  resolveCandidatesBatch,
  type NormalizedTarget,
  type SourceCandidate,
} from "./resolver";
import { extractHtmlText } from "./sidecar";

const ALLOWED_MIME_PREFIXES = ["text/html", "text/plain", "application/pdf"];
const NCBI_BIOC_PMCOA_PREFIX =
  "https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json";
const NCBI_BIOC_PUBMED_PREFIX =
  "https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pubmed.cgi/BioC_json";

function getCacheDir(): string {
  return process.env.ACQ_CACHE_DIR ?? join(process.cwd(), ".opencode", "acquired_docs");
}

const acquireTargetSchema = z.object({
  target: z.string().min(1).describe("DOI, PMID, PMCID, or URL"),
  source_type: z
    .enum(["doi", "pmid", "pmcid", "url"])
    .optional()
    .describe("Optional explicit source type"),
  metadata: z
    .object({
      title: z.string().optional(),
      authors: z.array(z.string()).optional(),
      published_at: z.string().optional(),
      journal: z.string().optional(),
      doi: z.string().optional(),
    })
    .optional(),
});

const acquireOptionsSchema = z
  .object({
    strict_policy: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true, enforce strict policy controls"),
    allowlist_tier: z
      .enum(["strict", "extended", "open"])
      .optional()
      .default("strict")
      .describe("Allowlist tier for source domains"),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .optional()
      .default(3_000_000)
      .describe("Maximum response payload in bytes"),
    max_redirects: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe("Maximum redirect hops per source"),
    request_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .default(20_000)
      .describe("Per-hop timeout in milliseconds"),
    prefer_cached: z
      .boolean()
      .optional()
      .default(true)
      .describe("Prefer cached acquisitions by source_id when available"),
    require_scrapling: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true, HTML extraction fails when Scrapling is unavailable"),
    max_concurrency: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(6)
      .describe("Maximum concurrent target acquisitions"),
    per_host_concurrency: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .default(2)
      .describe("Maximum concurrent requests per host"),
    idconv_batch_size: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(40)
      .describe("NCBI idconv batch size"),
  })
  .optional()
  .default({});

const acquireInputSchema = z.object({
  targets: z
    .array(acquireTargetSchema)
    .min(1)
    .max(20)
    .describe("Targets to acquire content from"),
  options: acquireOptionsSchema,
});

type AcquireOptions = z.infer<typeof acquireOptionsSchema>;
type AcquireTarget = z.infer<typeof acquireTargetSchema>;

interface ResolvedFetch {
  response: Response;
  finalUrl: string;
}

interface ExtractedBody {
  text: string;
  bytesRead: number;
}

interface NormalizedTargetInput {
  index: number;
  target: AcquireTarget;
  normalized: NormalizedTarget;
}

class Semaphore {
  private active = 0;

  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });

    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }
}

class HostLimiter {
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(private readonly perHostLimit: number) {}

  async runForUrl<T>(rawUrl: string, fn: () => Promise<T>): Promise<T> {
    const host = new URL(rawUrl).hostname.toLowerCase();
    let semaphore = this.semaphores.get(host);
    if (!semaphore) {
      semaphore = new Semaphore(this.perHostLimit);
      this.semaphores.set(host, semaphore);
    }
    return semaphore.run(fn);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function deriveLicenseHint(url: string): AcquisitionLicenseHint {
  const host = new URL(url).hostname.toLowerCase();
  if (
    host.includes("ncbi.nlm.nih.gov") ||
    host.includes("biorxiv.org") ||
    host.includes("medrxiv.org") ||
    host.includes("arxiv.org") ||
    host.includes("plos.org")
  ) {
    return "open_access";
  }
  return "unknown";
}

function deriveContentLevel(
  text: string,
  opts?: {
    provenanceUrl?: string;
    forcedLevel?: "metadata" | "abstract" | "full_text";
  },
): "metadata" | "abstract" | "full_text" {
  if (opts?.forcedLevel) return opts.forcedLevel;
  if (!text.trim()) return "metadata";
  if (opts?.provenanceUrl) {
    try {
      const host = new URL(opts.provenanceUrl).hostname.toLowerCase();
      // PubMed landing pages are abstract/metadata oriented, even when long page chrome exists.
      if (host === "pubmed.ncbi.nlm.nih.gov") return "abstract";
    } catch {
      // Ignore URL parse failures and fallback to text-length heuristic.
    }
  }
  if (text.length < 2500) return "abstract";
  return "full_text";
}

function sourceId(kind: AcquisitionSourceType, canonical: string): string {
  return sha256(`${kind}:${canonical}`).slice(0, 32);
}

function cachePathForSource(sourceIdValue: string): string {
  return join(getCacheDir(), `${sourceIdValue}.json`);
}

async function readCachedDocument(sourceIdValue: string): Promise<AcquiredDocument | null> {
  const path = cachePathForSource(sourceIdValue);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as AcquiredDocument;
  } catch {
    return null;
  }
}

async function writeCachedDocument(doc: AcquiredDocument): Promise<void> {
  const path = cachePathForSource(doc.source_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc, null, 2), "utf-8");
}

function isRedirectStatus(code: number): boolean {
  return code >= 300 && code < 400;
}

function normalizeMetadataDoi(raw?: string): string | undefined {
  return normalizeDoi(raw);
}

async function fetchWithRedirects(
  initialUrl: string,
  opts: {
    maxRedirects: number;
    timeoutMs: number;
    maxBytes: number;
    strictPolicy: boolean;
    allowlistTier: AllowlistTier;
    allowedPorts: number[];
    hostLimiter: HostLimiter;
  },
): Promise<ResolvedFetch> {
  let current = initialUrl;

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const policy = await evaluateUrlPolicyWithDns(current, {
      strictPolicy: opts.strictPolicy,
      allowlistTier: opts.allowlistTier,
      allowedPorts: opts.allowedPorts,
    });

    if (policy.blocked) {
      const reason = policy.reason ?? "Unknown policy block";
      const code = reason.toLowerCase().includes("dns")
        ? AcquisitionErrorCodes.DNS_BLOCKED
        : AcquisitionErrorCodes.BLOCKED_BY_POLICY;
      throw new AcquisitionError(code, reason, { blocked: true, retryable: false });
    }

    const response = await opts.hostLimiter.runForUrl(current, async () => {
      const basePolicy = evaluateUrlPolicy(current, {
        strictPolicy: opts.strictPolicy,
        allowlistTier: opts.allowlistTier,
        allowedPorts: opts.allowedPorts,
      });
      if (basePolicy.blocked) {
        throw new AcquisitionError(
          AcquisitionErrorCodes.BLOCKED_BY_POLICY,
          basePolicy.reason ?? "Blocked by URL policy",
          { blocked: true },
        );
      }

      return fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          "User-Agent": "medsci-agent-acquisition/0.2",
          Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
        },
      });
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new AcquisitionError(
          AcquisitionErrorCodes.REDIRECT_WITHOUT_LOCATION,
          "Redirect response missing Location header",
          { retryable: true },
        );
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (response.status >= 400) {
      throw new AcquisitionError(
        AcquisitionErrorCodes.ACQUISITION_FAILED,
        `Upstream returned HTTP ${response.status}`,
        {
          retryable: response.status >= 500 || response.status === 429,
        },
      );
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (!Number.isNaN(contentLength) && contentLength > opts.maxBytes) {
      throw new AcquisitionError(
        AcquisitionErrorCodes.CONTENT_TOO_LARGE,
        `Header content length ${contentLength} > ${opts.maxBytes}`,
      );
    }

    return { response, finalUrl: current };
  }

  throw new AcquisitionError(
    AcquisitionErrorCodes.TOO_MANY_REDIRECTS,
    `Exceeded ${opts.maxRedirects} redirects`,
    { retryable: true },
  );
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  encoding: "utf-8" | "latin1",
): Promise<ExtractedBody> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new AcquisitionError(
        AcquisitionErrorCodes.CONTENT_TOO_LARGE,
        `Body size ${bytes.byteLength} > ${maxBytes}`,
      );
    }
    return {
      text: new TextDecoder(encoding).decode(bytes),
      bytesRead: bytes.byteLength,
    };
  }

  const decoder = new TextDecoder(encoding);
  let text = "";
  let bytesRead = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!chunk.value) continue;
    bytesRead += chunk.value.byteLength;
    if (bytesRead > maxBytes) {
      throw new AcquisitionError(
        AcquisitionErrorCodes.CONTENT_TOO_LARGE,
        `Body size exceeded max threshold (${bytesRead} > ${maxBytes})`,
      );
    }
    text += decoder.decode(chunk.value, { stream: true });
  }

  text += decoder.decode();
  return { text, bytesRead };
}

async function responseToDocument(
  response: Response,
  finalUrl: string,
  normalized: { kind: AcquisitionSourceType; canonical: string },
  metadata: {
    title?: string;
    authors?: string[];
    published_at?: string;
    journal?: string;
    doi?: string;
  },
  opts: {
    maxBytes: number;
    requireScrapling: boolean;
  },
): Promise<AcquiredDocument> {
  const contentType = (response.headers.get("content-type") ?? "text/plain").toLowerCase();
  const allowed = ALLOWED_MIME_PREFIXES.some((mime) => contentType.includes(mime));
  if (!allowed) {
    throw new AcquisitionError(
      AcquisitionErrorCodes.MIME_NOT_ALLOWED,
      `Unsupported MIME type: ${contentType}`,
    );
  }

  let text = "";
  let title = metadata.title;
  let extractionConfidence = 0.7;
  let retrievalMethod: AcquiredDocument["retrieval_method"] = "scrapling_html";
  let extractionBackend: AcquisitionExtractionBackend = "plain_text";
  let fallbackUsed = false;

  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    const body = await readResponseTextWithLimit(response, opts.maxBytes, "utf-8");
    const html = body.text;
    try {
      const extracted = await extractHtmlText(html, finalUrl, opts.requireScrapling);
      text = normalizeWhitespace(extracted.text);
      title = title ?? extracted.title;
      extractionConfidence = extracted.extraction_confidence;
      extractionBackend = extracted.extraction_backend;
      fallbackUsed = extracted.fallback_used;
      retrievalMethod = extracted.retrieval_method;
    } catch (err) {
      const ae = toAcquisitionError(err);
      if (ae.message.includes("SCRAPLING_REQUIRED") || ae.code === AcquisitionErrorCodes.SIDECAR_DEPENDENCY_MISSING) {
        throw new AcquisitionError(
          AcquisitionErrorCodes.SCRAPLING_REQUIRED,
          ae.message,
          { retryable: false },
        );
      }
      throw new AcquisitionError(
        AcquisitionErrorCodes.EXTRACTION_FAILED,
        ae.message,
        { retryable: false },
      );
    }
  } else if (contentType.includes("application/pdf")) {
    const body = await readResponseTextWithLimit(response, opts.maxBytes, "latin1");
    text = normalizeWhitespace(body.text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " "));
    extractionConfidence = 0.2;
    retrievalMethod = "scrapling_pdf";
    extractionBackend = "pdf_text";
  } else {
    const body = await readResponseTextWithLimit(response, opts.maxBytes, "utf-8");
    text = normalizeWhitespace(body.text);
    extractionConfidence = 0.85;
    retrievalMethod = "scrapling_html";
    extractionBackend = "plain_text";
  }

  if (!text.trim()) {
    throw new AcquisitionError(
      AcquisitionErrorCodes.EXTRACTION_FAILED,
      "No text content extracted",
    );
  }

  return {
    source_id: sourceId(normalized.kind, normalized.canonical),
    source_type: normalized.kind,
    provenance_url: finalUrl,
    retrieval_method: retrievalMethod,
    license_hint: deriveLicenseHint(finalUrl),
    text,
    text_hash: sha256(text),
    metadata: {
      title,
      authors: metadata.authors,
      published_at: metadata.published_at,
      journal: metadata.journal,
      doi: normalizeMetadataDoi(metadata.doi),
    },
    extraction_confidence: extractionConfidence,
    extraction_backend: extractionBackend,
    fallback_used: fallbackUsed,
    policy: {
      allowed: true,
      blocked: false,
    },
    content_level: deriveContentLevel(text, { provenanceUrl: finalUrl }),
  };
}

function parsePmcidFromUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    const match = parsed.pathname.match(/\/articles\/(PMC\d+)\b/i);
    if (!match?.[1]) return undefined;
    return match[1].toUpperCase();
  } catch {
    return undefined;
  }
}

function parsePmidFromUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== "pubmed.ncbi.nlm.nih.gov") return undefined;
    const match = parsed.pathname.match(/^\/(\d+)\/?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function collectNcbiIds(
  normalized: NormalizedTarget,
  candidates: SourceCandidate[],
): { pmcid?: string; pmid?: string } {
  let pmcid = normalized.kind === "pmcid" ? normalized.canonical.toUpperCase() : undefined;
  let pmid = normalized.kind === "pmid" ? normalized.canonical : undefined;

  for (const candidate of candidates) {
    if (!pmcid) {
      const parsedPmcid = parsePmcidFromUrl(candidate.url);
      if (parsedPmcid) pmcid = parsedPmcid;
    }
    if (!pmid) {
      const parsedPmid = parsePmidFromUrl(candidate.url);
      if (parsedPmid) pmid = parsedPmid;
    }
    if (pmcid && pmid) break;
  }

  return { pmcid, pmid };
}

function extractBiocPassages(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const top = payload as Record<string, unknown>;
  const docs =
    Array.isArray(top.documents)
      ? top.documents
      : top.collection && typeof top.collection === "object"
        ? Array.isArray((top.collection as Record<string, unknown>).documents)
          ? ((top.collection as Record<string, unknown>).documents as unknown[])
          : []
        : [];

  const passages: string[] = [];
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const rawPassages = (doc as Record<string, unknown>).passages;
    if (!Array.isArray(rawPassages)) continue;
    for (const passage of rawPassages) {
      if (!passage || typeof passage !== "object") continue;
      const text = (passage as Record<string, unknown>).text;
      if (typeof text !== "string") continue;
      const cleaned = normalizeWhitespace(text);
      if (cleaned) passages.push(cleaned);
    }
  }

  return passages.join("\n\n");
}

async function fetchBiocText(
  url: string,
  opts: {
    maxBytes: number;
    timeoutMs: number;
    strictPolicy: boolean;
    allowlistTier: AllowlistTier;
    allowedPorts: number[];
    hostLimiter: HostLimiter;
  },
): Promise<string | null> {
  const fetched = await fetchWithRedirects(url, {
    maxRedirects: 1,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    strictPolicy: opts.strictPolicy,
    allowlistTier: opts.allowlistTier,
    allowedPorts: opts.allowedPorts,
    hostLimiter: opts.hostLimiter,
  });
  const body = await readResponseTextWithLimit(fetched.response, opts.maxBytes, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    throw new AcquisitionError(
      AcquisitionErrorCodes.EXTRACTION_FAILED,
      "NCBI BioC response was not valid JSON",
    );
  }
  const text = extractBiocPassages(json);
  return text || null;
}

async function tryAcquireViaNcbiBioc(input: {
  normalized: NormalizedTarget;
  metadata?: AcquireTarget["metadata"];
  options: AcquireOptions;
  candidates: SourceCandidate[];
  hostLimiter: HostLimiter;
}): Promise<AcquiredDocument | null> {
  if (input.normalized.kind !== "pmid" && input.normalized.kind !== "pmcid") {
    return null;
  }

  const { pmcid, pmid } = collectNcbiIds(input.normalized, input.candidates);
  const maxBytes = Math.min(
    input.options.max_bytes ?? 3_000_000,
    Number.parseInt(process.env.ACQ_MAX_BYTES_HARD_CAP ?? "10000000", 10),
  );
  const timeoutMs = input.options.request_timeout_ms ?? 20_000;
  const strictPolicy = input.options.strict_policy ?? true;
  const allowlistTier = input.options.allowlist_tier ?? "strict";
  const metadata = input.metadata ?? {};

  if (pmcid) {
    const fullTextEndpoint = `${NCBI_BIOC_PMCOA_PREFIX}/${pmcid}/unicode`;
    try {
      const text = await fetchBiocText(fullTextEndpoint, {
        maxBytes,
        timeoutMs,
        strictPolicy,
        allowlistTier,
        allowedPorts: [80, 443],
        hostLimiter: input.hostLimiter,
      });
      if (text?.trim()) {
        const provenanceUrl = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
        return {
          source_id: sourceId(input.normalized.kind, input.normalized.canonical),
          source_type: input.normalized.kind,
          provenance_url: provenanceUrl,
          retrieval_method: "ncbi_bioc",
          license_hint: deriveLicenseHint(provenanceUrl),
          text,
          text_hash: sha256(text),
          metadata: {
            title: metadata.title,
            authors: metadata.authors,
            published_at: metadata.published_at,
            journal: metadata.journal,
            doi: normalizeMetadataDoi(metadata.doi),
          },
          extraction_confidence: 0.96,
          extraction_backend: "plain_text",
          fallback_used: false,
          policy: {
            allowed: true,
            blocked: false,
          },
          content_level: deriveContentLevel(text, { forcedLevel: "full_text" }),
        };
      }
    } catch {
      // Best effort. Fall back to other routes if BioC full text fails.
    }
  }

  if (pmid) {
    const abstractEndpoint = `${NCBI_BIOC_PUBMED_PREFIX}/${pmid}/unicode`;
    try {
      const text = await fetchBiocText(abstractEndpoint, {
        maxBytes,
        timeoutMs,
        strictPolicy,
        allowlistTier,
        allowedPorts: [80, 443],
        hostLimiter: input.hostLimiter,
      });
      if (text?.trim()) {
        const provenanceUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
        return {
          source_id: sourceId(input.normalized.kind, input.normalized.canonical),
          source_type: input.normalized.kind,
          provenance_url: provenanceUrl,
          retrieval_method: "ncbi_bioc",
          license_hint: deriveLicenseHint(provenanceUrl),
          text,
          text_hash: sha256(text),
          metadata: {
            title: metadata.title,
            authors: metadata.authors,
            published_at: metadata.published_at,
            journal: metadata.journal,
            doi: normalizeMetadataDoi(metadata.doi),
          },
          extraction_confidence: 0.9,
          extraction_backend: "plain_text",
          fallback_used: false,
          policy: {
            allowed: true,
            blocked: false,
          },
          content_level: deriveContentLevel(text, { forcedLevel: "abstract" }),
        };
      }
    } catch {
      // Best effort. Fall back to Scrapling path if BioC abstract fails.
    }
  }

  return null;
}

function cloneAsCached(doc: AcquiredDocument): AcquiredDocument {
  return {
    ...doc,
    retrieval_method: "cached",
  };
}

async function acquireSingleCanonical(input: {
  targetLabel: string;
  normalized: NormalizedTarget;
  metadata?: AcquireTarget["metadata"];
  options: AcquireOptions;
  candidates: SourceCandidate[];
  hostLimiter: HostLimiter;
}): Promise<AcquisitionResultRecord> {
  const normalizedKey = {
    kind: input.normalized.kind,
    canonical: input.normalized.canonical,
  };
  const stableId = sourceId(input.normalized.kind, input.normalized.canonical);

  if (input.options.prefer_cached) {
    const cached = await readCachedDocument(stableId);
    if (cached) {
      return buildAcquiredResult({
        target: input.targetLabel,
        normalized: normalizedKey,
        document: cloneAsCached(cached),
      });
    }
  }

  const biocDocument = await tryAcquireViaNcbiBioc({
    normalized: input.normalized,
    metadata: input.metadata,
    options: input.options,
    candidates: input.candidates,
    hostLimiter: input.hostLimiter,
  });
  if (biocDocument) {
    await writeCachedDocument(biocDocument);
    return buildAcquiredResult({
      target: input.targetLabel,
      normalized: normalizedKey,
      document: biocDocument,
      sourceUrl: biocDocument.provenance_url,
    });
  }

  if (input.candidates.length === 0) {
    return buildFailedResult({
      target: input.targetLabel,
      normalized: normalizedKey,
      errorCode: AcquisitionErrorCodes.UNRESOLVED_SOURCE,
      errorDetail: "No candidate source URLs could be resolved",
      retryable: false,
      policy: { allowed: false, blocked: true, reason: "No candidate sources" },
    });
  }

  let lastError: AcquisitionError | null = null;
  let hadNonBlockedAttempt = false;

  for (const candidate of input.candidates) {
    try {
      const fetched = await fetchWithRedirects(candidate.url, {
        maxRedirects: input.options.max_redirects ?? 3,
        timeoutMs: input.options.request_timeout_ms ?? 20_000,
        maxBytes: input.options.max_bytes ?? 3_000_000,
        strictPolicy: input.options.strict_policy ?? true,
        allowlistTier: input.options.allowlist_tier ?? "strict",
        allowedPorts: [80, 443],
        hostLimiter: input.hostLimiter,
      });

      const hardCap = Number.parseInt(process.env.ACQ_MAX_BYTES_HARD_CAP ?? "10000000", 10);
      const effectiveBytes = Math.min(input.options.max_bytes ?? 3_000_000, hardCap);
      const acquired = await responseToDocument(
        fetched.response,
        fetched.finalUrl,
        {
          kind: input.normalized.kind,
          canonical: input.normalized.canonical,
        },
        input.metadata ?? {},
        {
          maxBytes: effectiveBytes,
          requireScrapling: input.options.require_scrapling ?? true,
        },
      );

      await writeCachedDocument(acquired);
      return buildAcquiredResult({
        target: input.targetLabel,
        normalized: normalizedKey,
        document: acquired,
        sourceUrl: acquired.provenance_url,
      });
    } catch (err) {
      const acqErr = toAcquisitionError(err);
      lastError = acqErr;

      if (
        acqErr.code === AcquisitionErrorCodes.BLOCKED_BY_POLICY ||
        acqErr.code === AcquisitionErrorCodes.DNS_BLOCKED
      ) {
        continue;
      }

      hadNonBlockedAttempt = true;
    }
  }

  if (!lastError) {
    return buildFailedResult({
      target: input.targetLabel,
      normalized: normalizedKey,
      errorCode: AcquisitionErrorCodes.ACQUISITION_FAILED,
      errorDetail: "All candidate sources failed",
      retryable: false,
    });
  }

  if (!hadNonBlockedAttempt && lastError.blocked) {
    return buildBlockedResult({
      target: input.targetLabel,
      normalized: normalizedKey,
      reason: lastError.message,
      errorCode: lastError.code,
      retryable: lastError.retryable,
    });
  }

  return buildFailedResult({
    target: input.targetLabel,
    normalized: normalizedKey,
    errorCode: lastError.code,
    errorDetail: lastError.message,
    retryable: lastError.retryable,
    policy: {
      allowed: !lastError.blocked,
      blocked: lastError.blocked,
      reason: lastError.blocked ? lastError.message : undefined,
    },
  });
}

function replaceTargetLabel(result: AcquisitionResultRecord, targetLabel: string): AcquisitionResultRecord {
  return {
    ...result,
    target: targetLabel,
  };
}

function normalizeResultForDuplicate(result: AcquisitionResultRecord, targetLabel: string): AcquisitionResultRecord {
  if (result.status !== "acquired" || !result.document) {
    return replaceTargetLabel(result, targetLabel);
  }
  return {
    ...result,
    target: targetLabel,
    document: cloneAsCached(result.document),
  };
}

export const acquireDocuments = defineTool({
  name: "acquire_documents",
  description:
    "Acquire policy-compliant scientific document text from DOI/PMID/PMCID/URL targets with provenance and content-level metadata.",
  schema: acquireInputSchema,
  execute: async (input, ctx) => {
    const options: AcquireOptions = {
      strict_policy: input.options?.strict_policy ?? true,
      allowlist_tier: input.options?.allowlist_tier ?? "strict",
      max_bytes: input.options?.max_bytes ?? 3_000_000,
      max_redirects: input.options?.max_redirects ?? 3,
      request_timeout_ms: input.options?.request_timeout_ms ?? 20_000,
      prefer_cached: input.options?.prefer_cached ?? true,
      require_scrapling: input.options?.require_scrapling ?? true,
      max_concurrency: input.options?.max_concurrency ?? 6,
      per_host_concurrency: input.options?.per_host_concurrency ?? 2,
      idconv_batch_size: input.options?.idconv_batch_size ?? 40,
    };

    const resultsByIndex: AcquisitionResultRecord[] = new Array(input.targets.length);
    const normalizedInputs: NormalizedTargetInput[] = [];

    for (const [index, target] of input.targets.entries()) {
      try {
        const normalized = normalizeTarget(target.target, target.source_type);
        normalizedInputs.push({
          index,
          target,
          normalized,
        });
      } catch (err) {
        const acqErr = toAcquisitionError(err);
        resultsByIndex[index] = buildFailedResult({
          target: target.target,
          errorCode: AcquisitionErrorCodes.INVALID_TARGET,
          errorDetail: acqErr.message,
          retryable: false,
          policy: { allowed: false, blocked: true, reason: "Invalid target" },
        });
      }
    }

    const canonicalGroups = new Map<string, NormalizedTargetInput[]>();
    for (const entry of normalizedInputs) {
      const key = `${entry.normalized.kind}:${entry.normalized.canonical}`;
      const group = canonicalGroups.get(key) ?? [];
      group.push(entry);
      canonicalGroups.set(key, group);
    }

    const uniqueEntries = [...canonicalGroups.values()].map((group) => group[0]);
    const candidateResolution = await resolveCandidatesBatch(
      uniqueEntries.map((u) => u.normalized),
      options.idconv_batch_size ?? 40,
    );
    const candidatesByKey = new Map<string, SourceCandidate[]>();
    for (const resolved of candidateResolution) {
      const key = `${resolved.target.kind}:${resolved.target.canonical}`;
      candidatesByKey.set(key, resolved.candidates);
    }

    const hostLimiter = new HostLimiter(options.per_host_concurrency ?? 2);
    const globalLimiter = new Semaphore(options.max_concurrency ?? 6);

    const uniqueResultByKey = new Map<string, AcquisitionResultRecord>();

    await Promise.all(
      uniqueEntries.map(async (entry) => {
        const key = `${entry.normalized.kind}:${entry.normalized.canonical}`;
        const candidates = candidatesByKey.get(key) ?? [];

        const result = await globalLimiter.run(() =>
          acquireSingleCanonical({
            targetLabel: entry.target.target,
            normalized: entry.normalized,
            metadata: entry.target.metadata,
            options,
            candidates,
            hostLimiter,
          }),
        );

        uniqueResultByKey.set(key, result);
      }),
    );

    for (const [key, group] of canonicalGroups.entries()) {
      const base = uniqueResultByKey.get(key);
      if (!base) continue;
      const [first, ...rest] = group;
      resultsByIndex[first.index] = replaceTargetLabel(base, first.target.target);
      for (const duplicate of rest) {
        resultsByIndex[duplicate.index] = normalizeResultForDuplicate(base, duplicate.target.target);
      }
    }

    const results = resultsByIndex.filter(
      (record): record is AcquisitionResultRecord => Boolean(record),
    );

    const summary = {
      total_targets: results.length,
      acquired: results.filter((r) => r.status === "acquired").length,
      blocked: results.filter((r) => r.status === "blocked").length,
      failed: results.filter((r) => r.status === "failed").length,
      content_levels: results
        .map((r) => r.document?.content_level)
        .filter(Boolean) as Array<"metadata" | "abstract" | "full_text">,
    };

    ctx.log.info(
      `[acquire_documents] policy summary acquired=${summary.acquired} blocked=${summary.blocked} failed=${summary.failed}`,
    );

    return {
      success: true,
      data: {
        options_applied: options,
        results,
        summary,
      },
    };
  },
});

export const __testing = {
  sourceId,
  deriveContentLevel,
  Semaphore,
};
