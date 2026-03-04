import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AcquisitionPolicyDecision } from "@medsci/core";

export type AllowlistTier = "strict" | "extended" | "open";

const STRICT_ALLOWLIST = [
	"ncbi.nlm.nih.gov",
	"pubmed.ncbi.nlm.nih.gov",
	"pmc.ncbi.nlm.nih.gov",
	"doi.org",
	"api.openalex.org",
	"openalex.org",
	"clinicaltrials.gov",
	"www.clinicaltrials.gov",
	"europepmc.org",
	"www.europepmc.org",
	"biorxiv.org",
	"www.biorxiv.org",
	"medrxiv.org",
	"www.medrxiv.org",
	"arxiv.org",
	"www.arxiv.org",
];

const EXTENDED_ALLOWLIST = [
	...STRICT_ALLOWLIST,
	"nature.com",
	"www.nature.com",
	"science.org",
	"www.science.org",
	"thelancet.com",
	"www.thelancet.com",
	"nejm.org",
	"www.nejm.org",
	"jamanetwork.com",
	"www.jamanetwork.com",
	"bmj.com",
	"www.bmj.com",
	"cell.com",
	"www.cell.com",
	"plos.org",
	"www.plos.org",
	"frontiersin.org",
	"www.frontiersin.org",
];

const ALLOWLISTS: Record<AllowlistTier, string[]> = {
	strict: STRICT_ALLOWLIST,
	extended: EXTENDED_ALLOWLIST,
	open: [],
};

const LOCAL_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"0.0.0.0",
	"host.docker.internal",
]);

function isIPv4(value: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function isPrivateIPv4(host: string): boolean {
	if (!isIPv4(host)) return false;
	const parts = host.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
	if (parts[0] === 10) return true;
	if (parts[0] === 127) return true;
	if (parts[0] === 0) return true;
	if (parts[0] === 169 && parts[1] === 254) return true;
	if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
	if (parts[0] === 192 && parts[1] === 168) return true;
	return false;
}

function isPrivateIPv6(host: string): boolean {
	const value = host.toLowerCase();
	if (value === "::1" || value === "::") return true;
	if (value.startsWith("fc") || value.startsWith("fd")) return true; // ULA fc00::/7
	if (
		value.startsWith("fe8") ||
		value.startsWith("fe9") ||
		value.startsWith("fea") ||
		value.startsWith("feb")
	) {
		return true; // link-local fe80::/10
	}

	// IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
	const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
	return false;
}

function isPrivateAddress(address: string): boolean {
	const ipType = isIP(address);
	if (ipType === 4) return isPrivateIPv4(address);
	if (ipType === 6) return isPrivateIPv6(address);
	return false;
}

function hostInAllowlist(host: string, tier: AllowlistTier): boolean {
	if (tier === "open") return true;
	const allowlist = ALLOWLISTS[tier];
	return allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function evaluateUrlPolicy(
	rawUrl: string,
	opts: {
		strictPolicy: boolean;
		allowlistTier: AllowlistTier;
		allowedPorts: number[];
	},
): AcquisitionPolicyDecision {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return {
			allowed: false,
			blocked: true,
			reason: "Invalid URL",
		};
	}

	const protocol = parsed.protocol.toLowerCase();
	if (protocol !== "https:" && protocol !== "http:") {
		return {
			allowed: false,
			blocked: true,
			reason: "Blocked non-HTTP(S) protocol",
		};
	}

	const host = parsed.hostname.toLowerCase();
	const unwrappedHost =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(unwrappedHost) || host.endsWith(".local")) {
		return {
			allowed: false,
			blocked: true,
			reason: "Blocked localhost/private network target",
		};
	}

	if (isPrivateAddress(unwrappedHost)) {
		return {
			allowed: false,
			blocked: true,
			reason: "Blocked localhost/private network target",
		};
	}

	if (!hostInAllowlist(host, opts.allowlistTier)) {
		return {
			allowed: false,
			blocked: true,
			reason: `Domain is not in ${opts.allowlistTier} allowlist tier`,
		};
	}

	if (parsed.username || parsed.password) {
		return {
			allowed: false,
			blocked: true,
			reason: "Blocked URL with embedded credentials",
		};
	}

	if (opts.strictPolicy) {
		const port = parsed.port
			? Number.parseInt(parsed.port, 10)
			: parsed.protocol === "https:"
				? 443
				: 80;
		if (!opts.allowedPorts.includes(port)) {
			return {
				allowed: false,
				blocked: true,
				reason: `Blocked non-standard port ${port}`,
			};
		}
	}

	return {
		allowed: true,
		blocked: false,
	};
}

export async function evaluateUrlPolicyWithDns(
	rawUrl: string,
	opts: {
		strictPolicy: boolean;
		allowlistTier: AllowlistTier;
		allowedPorts: number[];
	},
	resolveHost: typeof lookup = lookup,
): Promise<AcquisitionPolicyDecision> {
	const basePolicy = evaluateUrlPolicy(rawUrl, opts);
	if (basePolicy.blocked) return basePolicy;

	try {
		const parsed = new URL(rawUrl);
		const host = parsed.hostname.toLowerCase();
		const unwrappedHost =
			host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
		const ipType = isIP(unwrappedHost);
		if (ipType > 0) {
			if (isPrivateAddress(unwrappedHost)) {
				return {
					allowed: false,
					blocked: true,
					reason: "Blocked private IP target after resolution",
				};
			}
			return basePolicy;
		}

		const records = await resolveHost(unwrappedHost, { all: true, verbatim: true });
		for (const rec of records) {
			if (isPrivateAddress(rec.address)) {
				return {
					allowed: false,
					blocked: true,
					reason: "Blocked private IP target after DNS resolution",
				};
			}
		}
		return basePolicy;
	} catch {
		// Fail soft on DNS resolution errors; fetch path will still fail safely.
		return basePolicy;
	}
}

export const __testing = {
	isPrivateIPv4,
	isPrivateIPv6,
	isPrivateAddress,
};
