import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolveConfig } from "../config";

describe("resolveConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clean relevant env vars
    delete process.env.MEDSCI_PROFILE;
    delete process.env.MEDSCI_OLLAMA_URL;
    delete process.env.MEDSCI_OLLAMA_MODEL;
    delete process.env.MEDSCI_OLLAMA_TIMEOUT;
    delete process.env.MEDSCI_PYTHON;
    delete process.env.MEDSCI_PYTHON_TIMEOUT;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  test("returns standard profile by default", () => {
    const config = resolveConfig();
    expect(config.profileConfig.reasoningModel).toBe("medgemma:latest");
    expect(config.profileConfig.pythonPreload).toEqual(["rdkit", "scanpy", "biopython"]);
  });

  test("resolves lite profile", () => {
    process.env.MEDSCI_PROFILE = "lite";
    const config = resolveConfig();
    expect(config.profileConfig.reasoningModel).toBe("medgemma:latest");
    expect(config.profileConfig.pythonPreload).toEqual(["rdkit"]);
  });

  test("resolves full profile", () => {
    process.env.MEDSCI_PROFILE = "full";
    const config = resolveConfig();
    expect(config.profileConfig.reasoningModel).toBe("medgemma:latest");
    expect(config.profileConfig.pythonPreload).toBe("all");
  });

  test("throws on unknown profile", () => {
    process.env.MEDSCI_PROFILE = "nonexistent";
    expect(() => resolveConfig()).toThrow('Unknown profile "nonexistent"');
  });

  test("uses env overrides for Ollama", () => {
    process.env.MEDSCI_OLLAMA_URL = "http://gpu-server:11434";
    process.env.MEDSCI_OLLAMA_MODEL = "custom-model";
    process.env.MEDSCI_OLLAMA_TIMEOUT = "30000";
    const config = resolveConfig();
    expect(config.ollama.baseUrl).toBe("http://gpu-server:11434");
    expect(config.ollama.defaultModel).toBe("custom-model");
    expect(config.ollama.timeoutMs).toBe(30000);
  });

  test("uses env overrides for Python", () => {
    process.env.MEDSCI_PYTHON = "/usr/local/bin/python3.11";
    process.env.MEDSCI_PYTHON_TIMEOUT = "90000";
    const config = resolveConfig();
    expect(config.python.binary).toBe("/usr/local/bin/python3.11");
    expect(config.python.timeoutMs).toBe(90000);
  });

  test("uses profile model as default when no model env var", () => {
    process.env.MEDSCI_PROFILE = "lite";
    const config = resolveConfig();
    expect(config.ollama.defaultModel).toBe("medgemma:latest");
  });
});
