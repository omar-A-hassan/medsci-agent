import { describe, expect, test } from "bun:test";
import { isDoi, normalizeDoi, stripDoiResolver } from "../doi";

describe("DOI helpers", () => {
	test("normalizes DOI resolver URLs and preserves suffix case", () => {
		expect(normalizeDoi("https://doi.org/10.1056/NEJMoa1603827")).toBe(
			"10.1056/NEJMoa1603827",
		);
		expect(normalizeDoi("https://dx.doi.org/10.1234/ABCdef")).toBe(
			"10.1234/ABCdef",
		);
	});

	test("strips trailing [doi] and normalizes prefix only", () => {
		expect(normalizeDoi("10.1000/XYZ [doi]")).toBe("10.1000/XYZ");
		expect(normalizeDoi(" 10.5555/AbC ")).toBe("10.5555/AbC");
	});

	test("rejects invalid DOI shapes", () => {
		expect(normalizeDoi("not-a-doi")).toBeUndefined();
		expect(normalizeDoi("10.1")).toBeUndefined();
		expect(isDoi("foo")).toBe(false);
		expect(isDoi("10.1056/NEJMoa1603827")).toBe(true);
	});

	test("stripDoiResolver removes DOI host prefixes only", () => {
		expect(stripDoiResolver("https://doi.org/10.1000/test")).toBe("10.1000/test");
		expect(stripDoiResolver("https://dx.doi.org/10.1000/test")).toBe("10.1000/test");
		expect(stripDoiResolver("10.1000/test")).toBe("10.1000/test");
	});
});
