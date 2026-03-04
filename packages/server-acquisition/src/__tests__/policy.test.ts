import { describe, expect, test } from "bun:test";
import { evaluateUrlPolicy, evaluateUrlPolicyWithDns } from "../tools/policy";

const baseOpts = {
  strictPolicy: true,
  allowlistTier: "open" as const,
  allowedPorts: [80, 443],
};

describe("acquisition policy", () => {
  test("blocks embedded credentials, non-standard ports, .local, and ipv6 loopback literals", () => {
    const cases = [
      "http://user:pass@example.org/paper",
      "https://example.org:8443/paper",
      "https://internal.local/paper",
      "http://[::1]/paper",
    ];

    for (const rawUrl of cases) {
      const policy = evaluateUrlPolicy(rawUrl, baseOpts);
      expect(policy.blocked).toBe(true);
    }
  });

  test("dns policy blocks domain that resolves to private IPv4", async () => {
    const policy = await evaluateUrlPolicyWithDns(
      "https://example.org/paper",
      baseOpts,
      async () => [{ address: "10.0.0.5", family: 4 }],
    );
    expect(policy.blocked).toBe(true);
    expect(policy.reason).toContain("private IP target");
  });

  test("dns policy blocks domain that resolves to ipv6 loopback", async () => {
    const policy = await evaluateUrlPolicyWithDns(
      "https://example.org/paper",
      baseOpts,
      async () => [{ address: "::1", family: 6 }],
    );
    expect(policy.blocked).toBe(true);
    expect(policy.reason).toContain("private IP target");
  });
});
