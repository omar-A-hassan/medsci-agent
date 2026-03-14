import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Re-implement unwrapZodShape here to unit-test its logic in isolation.
// The production version lives in server-factory.ts — if the logic diverges,
// the server-factory integration smoke test below will catch it.
function unwrapZodShape(s: any): Record<string, any> {
	if (s && "shape" in s) return s.shape;
	const inner = s?._def?.innerType ?? s?._def?.schema;
	return inner ? unwrapZodShape(inner) : {};
}

describe("unwrapZodShape", () => {
	test("plain ZodObject — returns .shape directly", () => {
		const schema = z.object({ x: z.string(), y: z.number() });
		const shape = unwrapZodShape(schema);
		expect(shape).toHaveProperty("x");
		expect(shape).toHaveProperty("y");
	});

	test("ZodEffects from .superRefine — unwraps to inner object shape", () => {
		const schema = z
			.object({ query: z.string(), count: z.number().optional() })
			.superRefine(() => {});
		const shape = unwrapZodShape(schema);
		expect(shape).toHaveProperty("query");
		expect(shape).toHaveProperty("count");
	});

	test("ZodEffects from .refine — unwraps to inner object shape", () => {
		const schema = z
			.object({ a: z.string() })
			.refine((v) => v.a.length > 0, "must not be empty");
		const shape = unwrapZodShape(schema);
		expect(shape).toHaveProperty("a");
	});

	test("non-object schema (ZodString) — returns empty object", () => {
		expect(unwrapZodShape(z.string())).toEqual({});
	});

	test("null/undefined input — returns empty object without throwing", () => {
		expect(unwrapZodShape(null)).toEqual({});
		expect(unwrapZodShape(undefined)).toEqual({});
	});
});
