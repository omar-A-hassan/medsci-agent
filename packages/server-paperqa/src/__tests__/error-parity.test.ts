import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function parsePythonCodes(source: string): Set<string> {
  const out = new Set<string>();
  const regex = /^EC_[A-Z0-9_]+\s*=\s*"([A-Z0-9_]+)"/gm;
  for (const match of source.matchAll(regex)) {
    out.add(match[1]);
  }
  return out;
}

function parseTsMapCodes(source: string): Set<string> {
  const out = new Set<string>();
  const mapMatch = source.match(/const\s+PAPERQA_ERROR_MAP\s*:\s*Record<string, string>\s*=\s*\{([\s\S]*?)\};/);
  if (!mapMatch) return out;
  const body = mapMatch[1];
  const regex = /^\s*([A-Z0-9_]+)\s*:/gm;
  for (const match of body.matchAll(regex)) {
    out.add(match[1]);
  }
  return out;
}

function parseDocCodes(source: string): Set<string> {
  const out = new Set<string>();
  const regex = /\|\s*`([A-Z0-9_]+)`\s*\|/g;
  for (const match of source.matchAll(regex)) {
    out.add(match[1]);
  }
  return out;
}

describe("paperqa error-code parity", () => {
  test("TS map and docs are synchronized and backed by Python codes", () => {
    const pythonSrc = readFileSync(
      join(import.meta.dir, "../../python/paperqa_server.py"),
      "utf-8",
    );
    const tsSrc = readFileSync(
      join(import.meta.dir, "../tools/search-and-analyze.ts"),
      "utf-8",
    );
    const docsSrc = readFileSync(
      join(import.meta.dir, "../../../../.opencode/agents/medsci.md"),
      "utf-8",
    );

    const pythonCodes = parsePythonCodes(pythonSrc);
    const tsCodes = parseTsMapCodes(tsSrc);
    const docCodes = parseDocCodes(docsSrc);

    expect(tsCodes.size).toBeGreaterThan(0);
    expect(docCodes.size).toBeGreaterThan(0);

    for (const code of tsCodes) {
      expect(pythonCodes.has(code)).toBe(true);
    }
    for (const code of docCodes) {
      expect(pythonCodes.has(code)).toBe(true);
    }

    expect([...tsCodes].sort()).toEqual([...docCodes].sort());
  });
});
