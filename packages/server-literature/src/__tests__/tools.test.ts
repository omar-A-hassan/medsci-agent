import { test, expect, describe, mock, afterEach } from "bun:test";
import { createMockContext } from "@medsci/core";
import { fetchAbstract } from "../tools/fetch-abstract";
import { searchClinicalTrials } from "../tools/search-clinical-trials";
import { searchPubmed } from "../tools/search-pubmed";
import { searchOpenAlex } from "../tools/search-openalex";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetch_abstract", () => {
  test("returns parsed abstract with interpretation", async () => {
    const mockXml = `
      <PubmedArticle>
        <ArticleTitle>Test Article Title</ArticleTitle>
        <AbstractText>This study demonstrates important findings.</AbstractText>
        <Title>Nature Medicine</Title>
        <Year>2024</Year>
        <DescriptorName>Immunology</DescriptorName>
        <DescriptorName>Cancer</DescriptorName>
      </PubmedArticle>`;

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(mockXml, { status: 200 })),
    ) as any;

    const ctx = createMockContext();
    const result = await fetchAbstract.execute({ pmid: "12345678" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.title).toBe("Test Article Title");
    expect(result.data?.abstract).toContain("important findings");
    expect(result.data?.journal).toBe("Nature Medicine");
    expect(result.data?.mesh_terms).toContain("Immunology");
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("returns error on PubMed API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 500 })),
    ) as any;

    const ctx = createMockContext();
    const result = await fetchAbstract.execute({ pmid: "12345678" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("PubMed fetch failed");
  });
});

describe("search_pubmed", () => {
  test("returns articles with interpretation", async () => {
    globalThis.fetch = mock((url: string) => {
      if (typeof url === "string" && url.includes("esearch")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ esearchresult: { idlist: ["111", "222"] } }),
            { status: 200 },
          ),
        );
      }
      // esummary
      return Promise.resolve(
        new Response(
          JSON.stringify({
            result: {
              "111": { title: "Article One", source: "Lancet", pubdate: "2024" },
              "222": { title: "Article Two", source: "BMJ", pubdate: "2023" },
            },
          }),
          { status: 200 },
        ),
      );
    }) as any;

    const ctx = createMockContext();
    const result = await searchPubmed.execute({ query: "diabetes" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.n_results).toBe(2);
    expect(result.data?.articles[0].title).toBe("Article One");
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("returns empty results when no PMIDs found", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ esearchresult: { idlist: [] } }),
          { status: 200 },
        ),
      ),
    ) as any;

    const ctx = createMockContext();
    const result = await searchPubmed.execute({ query: "xyznotaquery" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.n_results).toBe(0);
  });

  test("returns error on search API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 503 })),
    ) as any;

    const ctx = createMockContext();
    const result = await searchPubmed.execute({ query: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("PubMed search failed");
  });
});

describe("search_clinical_trials", () => {
  test("returns trials with interpretation", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            studies: [
              {
                protocolSection: {
                  identificationModule: { nctId: "NCT001", briefTitle: "Trial A" },
                  statusModule: { overallStatus: "RECRUITING" },
                  designModule: { phases: ["PHASE3"], enrollmentInfo: { count: 500 } },
                  descriptionModule: { briefSummary: "A test trial." },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const ctx = createMockContext();
    const result = await searchClinicalTrials.execute({ query: "diabetes" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.n_results).toBe(1);
    expect(result.data?.results[0].nct_id).toBe("NCT001");
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("returns error on ClinicalTrials API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 429 })),
    ) as any;

    const ctx = createMockContext();
    const result = await searchClinicalTrials.execute({ query: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("429");
  });
});

describe("search_openalex", () => {
  test("returns scholarly works with interpretation", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            meta: { count: 1234 },
            results: [
              {
                id: "W123",
                title: "CRISPR advances in oncology",
                authorships: [{ author: { display_name: "Jane Doe" } }],
                publication_date: "2024-06-15",
                primary_location: { source: { display_name: "Nature" } },
                doi: "https://doi.org/10.1234/test",
                cited_by_count: 42,
                open_access: { is_oa: true },
                concepts: [{ display_name: "CRISPR" }, { display_name: "Oncology" }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const ctx = createMockContext();
    const result = await searchOpenAlex.execute({ query: "CRISPR oncology" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.n_results).toBe(1);
    expect(result.data?.total_count).toBe(1234);
    expect(result.data?.results[0].title).toBe("CRISPR advances in oncology");
    expect(result.data?.results[0].cited_by_count).toBe(42);
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("returns error on OpenAlex API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 })),
    ) as any;

    const ctx = createMockContext();
    const result = await searchOpenAlex.execute({ query: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });
});
