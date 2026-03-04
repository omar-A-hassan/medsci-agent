const DOI_REGEX = /^10\.\d{4,9}\/\S+$/i;

export function stripDoiResolver(raw: string): string {
	return raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
}

export function normalizeDoi(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	const stripped = stripDoiResolver(raw).replace(/\s*\[doi\]\s*$/i, "").trim();
	if (!DOI_REGEX.test(stripped)) return undefined;
	const [prefix, ...rest] = stripped.split("/");
	if (rest.length === 0) return undefined;
	return `${prefix.toLowerCase()}/${rest.join("/")}`;
}

export function isDoi(raw: string | null | undefined): boolean {
	return normalizeDoi(raw) !== undefined;
}
