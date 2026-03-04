import { normalizeDoi, resilientFetch } from "@medsci/core";
import {
	AcquisitionError,
	AcquisitionErrorCodes,
} from "./errors";

export type IdentifierKind = "doi" | "pmid" | "pmcid" | "url";

export interface NormalizedTarget {
	kind: IdentifierKind;
	raw: string;
	canonical: string;
}

export interface SourceCandidate {
	url: string;
	source: string;
	confidence: number;
	provenance: string;
}

interface IdConvRecordWire {
	"requested-id"?: unknown;
	requested_id?: unknown;
	pmcid?: unknown;
	pmid?: unknown;
	doi?: unknown;
}

interface IdConvResponseWire {
	records?: unknown;
}

interface IdConvRecordNormalized {
	requested: string;
	pmcid?: string;
	pmid?: string;
	doi?: string;
}

function normalizeLookupIdentifier(value: string): string {
	const raw = value.trim();
	if (/^pmc\d+$/i.test(raw)) return raw.toUpperCase();
	if (/^\d+$/.test(raw)) return raw;
	return normalizeDoi(raw) ?? raw.toLowerCase();
}

function normalizePmid(raw: string): string {
	const value = raw.trim();
	if (!/^\d+$/.test(value)) {
		throw new AcquisitionError(
			AcquisitionErrorCodes.INVALID_TARGET,
			`Unsupported PMID format: ${raw}`,
		);
	}
	return value;
}

function normalizePmcid(raw: string): string {
	const value = raw.trim();
	if (!/^pmc\d+$/i.test(value)) {
		throw new AcquisitionError(
			AcquisitionErrorCodes.INVALID_TARGET,
			`Unsupported PMCID format: ${raw}`,
		);
	}
	return value.toUpperCase();
}

function normalizeDoiOrThrow(raw: string): string {
	const normalized = normalizeDoi(raw);
	if (!normalized) {
		throw new AcquisitionError(
			AcquisitionErrorCodes.INVALID_TARGET,
			`Unsupported DOI format: ${raw}`,
		);
	}
	return normalized;
}

export function normalizeTarget(raw: string, hinted?: IdentifierKind): NormalizedTarget {
	const value = (raw || "").trim();
	if (!value) {
		throw new AcquisitionError(AcquisitionErrorCodes.INVALID_TARGET, "Target is empty");
	}

	if (hinted === "url") {
		if (!/^https?:\/\//i.test(value)) {
			throw new AcquisitionError(
				AcquisitionErrorCodes.INVALID_TARGET,
				`Unsupported URL format: ${raw}`,
			);
		}
		return { kind: "url", raw: value, canonical: value };
	}

	if (hinted === "pmcid") {
		return { kind: "pmcid", raw: value, canonical: normalizePmcid(value) };
	}

	if (hinted === "pmid") {
		return { kind: "pmid", raw: value, canonical: normalizePmid(value) };
	}

	if (hinted === "doi") {
		return { kind: "doi", raw: value, canonical: normalizeDoiOrThrow(value) };
	}

	if (/^https?:\/\//i.test(value)) {
		return { kind: "url", raw: value, canonical: value };
	}

	if (/^pmc\d+$/i.test(value)) {
		return { kind: "pmcid", raw: value, canonical: value.toUpperCase() };
	}

	if (/^\d+$/.test(value)) {
		return { kind: "pmid", raw: value, canonical: value };
	}

	const doi = normalizeDoi(value);
	if (doi) {
		return { kind: "doi", raw: value, canonical: doi };
	}

	throw new AcquisitionError(
		AcquisitionErrorCodes.INVALID_TARGET,
		`Unsupported target format: ${raw}`,
	);
}

function deterministicCandidates(target: NormalizedTarget): SourceCandidate[] {
	if (target.kind === "url") {
		return [
			{
				url: target.canonical,
				source: "direct_url",
				confidence: 0.95,
				provenance: "user_input",
			},
		];
	}

	const out: SourceCandidate[] = [];
	if (target.kind === "doi") {
		out.push({
			url: `https://doi.org/${target.canonical}`,
			source: "doi_resolver",
			confidence: 0.85,
			provenance: "identifier_transform",
		});
	}
	if (target.kind === "pmid") {
		out.push({
			url: `https://pubmed.ncbi.nlm.nih.gov/${target.canonical}/`,
			source: "pubmed_landing",
			confidence: 0.85,
			provenance: "identifier_transform",
		});
	}
	if (target.kind === "pmcid") {
		out.push({
			url: `https://pmc.ncbi.nlm.nih.gov/articles/${target.canonical}/`,
			source: "pmc_article",
			confidence: 0.98,
			provenance: "identifier_transform",
		});
	}
	return out;
}

function parseIdConvRecords(payload: unknown): IdConvRecordNormalized[] {
	if (!payload || typeof payload !== "object") return [];
	const wire = payload as IdConvResponseWire;
	if (!Array.isArray(wire.records)) return [];
	const out: IdConvRecordNormalized[] = [];

	for (const item of wire.records as IdConvRecordWire[]) {
		if (!item || typeof item !== "object") continue;
		const requestedRaw =
			typeof item["requested-id"] === "string"
				? item["requested-id"]
				: typeof item.requested_id === "string"
					? item.requested_id
					: typeof item.doi === "string"
								? item.doi
								: "";
		const requested = requestedRaw ? normalizeLookupIdentifier(requestedRaw) : "";
		const pmcid = typeof item.pmcid === "string" ? item.pmcid.toUpperCase() : undefined;
		const pmid =
			typeof item.pmid === "string"
				? /^\d+$/.test(item.pmid)
					? item.pmid
					: undefined
				: undefined;
		const doi = typeof item.doi === "string" ? normalizeDoi(item.doi) : undefined;

		out.push({ requested, pmcid, pmid, doi });
	}
	return out;
}

async function fetchIdConvRecordBatch(
	identifiers: string[],
): Promise<Map<string, IdConvRecordNormalized>> {
	if (identifiers.length === 0) return new Map();

	const email = process.env.PQA_EMAIL ?? "medsci-agent@localhost";
	const joined = identifiers.join(",");
	const url =
		"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/" +
		`?ids=${encodeURIComponent(joined)}&format=json&tool=medsci-agent&email=${encodeURIComponent(email)}`;

	const res = await resilientFetch(url, {
		signal: AbortSignal.timeout(15_000),
		maxRetries: 2,
	});

	if (!res.ok) return new Map();
	const json = (await res.json()) as unknown;
	const records = parseIdConvRecords(json);
	const out = new Map<string, IdConvRecordNormalized>();
	for (const [index, record] of records.entries()) {
		let key = record.requested;
		if (!key) {
			if (identifiers.length === 1) {
				key = identifiers[0];
			} else if (identifiers[index]) {
				key = identifiers[index];
			}
		}
		if (key) {
			out.set(key, { ...record, requested: key });
		}
	}
	return out;
}

export async function resolveCandidatesBatch(
	targets: NormalizedTarget[],
	batchSize = 40,
): Promise<Array<{ target: NormalizedTarget; candidates: SourceCandidate[] }>> {
	const nonUrlLookupIds = [
		...new Set(
			targets
				.filter((t) => t.kind !== "url")
				.map((t) => normalizeLookupIdentifier(t.canonical)),
		),
	];

	const idConvMap = new Map<string, IdConvRecordNormalized>();
	for (let i = 0; i < nonUrlLookupIds.length; i += batchSize) {
		const chunk = nonUrlLookupIds.slice(i, i + batchSize);
		try {
			const chunkMap = await fetchIdConvRecordBatch(chunk);
			for (const [key, value] of chunkMap) {
				idConvMap.set(key, value);
			}
		} catch {
			// Best-effort resolution; deterministic candidates still apply.
		}
	}

	return targets.map((target) => {
		const out = deterministicCandidates(target);
		const lookupKey = normalizeLookupIdentifier(target.canonical);
		const rec = idConvMap.get(lookupKey);

		if (rec?.pmcid) {
			out.push({
				url: `https://pmc.ncbi.nlm.nih.gov/articles/${rec.pmcid}/`,
				source: "ncbi_idconv_pmc",
				confidence: 0.98,
				provenance: "ncbi_id_converter",
			});
		}
		if (rec?.pmid) {
			out.push({
				url: `https://pubmed.ncbi.nlm.nih.gov/${rec.pmid}/`,
				source: "ncbi_idconv_pubmed",
				confidence: 0.88,
				provenance: "ncbi_id_converter",
			});
		}
		if (rec?.doi) {
			out.push({
				url: `https://doi.org/${rec.doi}`,
				source: "ncbi_idconv_doi",
				confidence: 0.86,
				provenance: "ncbi_id_converter",
			});
		}

		const deduped = new Map<string, SourceCandidate>();
		for (const candidate of out) {
			if (!deduped.has(candidate.url)) {
				deduped.set(candidate.url, candidate);
			}
		}

		return {
			target,
			candidates: [...deduped.values()],
		};
	});
}

export async function resolveCandidates(
	target: NormalizedTarget,
): Promise<{ target: NormalizedTarget; candidates: SourceCandidate[] }> {
	const [resolved] = await resolveCandidatesBatch([target], 1);
	return resolved;
}
