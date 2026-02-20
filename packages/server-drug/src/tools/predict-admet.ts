import { z } from "zod";
import { defineTool } from "@medsci/core";

export const predictAdmet = defineTool({
  name: "predict_admet",
  description:
    "Predict ADMET (Absorption, Distribution, Metabolism, Excretion, Toxicity) properties for a molecule using MedGemma. Returns risk assessments for key safety endpoints.",
  schema: z.object({
    smiles: z.string().min(1).describe("SMILES string of the molecule"),
  }),
  execute: async (input, ctx) => {
    // Step 1: Get molecular properties from RDKit
    const props = await ctx.python.call<{
      valid: boolean;
      error?: string;
      molecular_weight?: number;
      logp?: number;
      tpsa?: number;
      hbd?: number;
      hba?: number;
      rotatable_bonds?: number;
    }>("rdkit.mol_from_smiles", { smiles: input.smiles });

    if (!props.valid) {
      return { success: false, error: props.error ?? "Invalid SMILES" };
    }

    // Step 2: Use MedGemma for ADMET reasoning
    const basePrompt = [
      `Analyze the following molecule for ADMET properties.`,
      `SMILES: ${input.smiles}`,
      `Properties: MW=${props.molecular_weight}, LogP=${props.logp}, TPSA=${props.tpsa}, HBD=${props.hbd}, HBA=${props.hba}, RotBonds=${props.rotatable_bonds}`,
      ``,
      `Predict and provide a JSON response with these fields:`,
      `- absorption: "high" | "medium" | "low" with reasoning`,
      `- bbb_penetration: "yes" | "no" with reasoning`,
      `- cyp_inhibition: list of likely inhibited CYP enzymes`,
      `- herg_risk: "high" | "medium" | "low"`,
      `- hepatotoxicity_risk: "high" | "medium" | "low"`,
      `- overall_druglikeness: score 0-1`,
      `Respond ONLY with valid JSON.`,
    ].join("\n");
    // Prompt repetition improves non-reasoning model accuracy (arXiv:2512.14982)
    const prompt = `${basePrompt}\n\nTo reiterate:\n${basePrompt}`;

    let admet: Record<string, unknown>;
    let model_used = true;
    try {
      admet = await ctx.ollama.generateJson<Record<string, unknown>>(prompt, {
        system: "You are a medicinal chemistry expert. Respond only with valid JSON.",
        temperature: 0.2,
        maxTokens: 500,
      });
    } catch {
      model_used = false;
      // Fallback: rule-based estimates from physicochemical properties
      admet = {
        absorption: (props.tpsa ?? 0) < 140 ? "high" : "low",
        bbb_penetration: (props.tpsa ?? 0) < 90 && (props.molecular_weight ?? 0) < 450 ? "likely" : "unlikely",
        herg_risk: (props.logp ?? 0) > 3.7 ? "medium" : "low",
        hepatotoxicity_risk: "unknown",
        overall_druglikeness: props.molecular_weight! < 500 && props.logp! < 5 ? 0.7 : 0.3,
        note: "Rule-based fallback — model response could not be parsed",
      };
    }

    return {
      success: true,
      data: {
        smiles: input.smiles,
        physicochemical: props,
        admet,
        model_used,
      },
    };
  },
});
