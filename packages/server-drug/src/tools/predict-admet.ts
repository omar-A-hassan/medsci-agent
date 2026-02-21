import { z } from "zod";
import { defineTool, interpretWithMedGemma } from "@medsci/core";

export const TXGEMMA_MODEL = "hf.co/matrixportalx/txgemma-2b-predict-GGUF:Q4_K_M";

// Exact TDC prompt templates from google/txgemma-2b-predict/tdc_prompts.json.
// These are the verbatim prompts TxGemma was trained on — do NOT modify the text.
// Each template has a {Drug SMILES} placeholder replaced at runtime.
// All endpoints are binary classification: output is "(A)" or "(B)".
const ADMET_ENDPOINTS = [
  {
    name: "bbb",
    label: "Blood-Brain Barrier",
    prompt:
      "Instructions: Answer the following question about drug properties.\n" +
      "Context: As a membrane separating circulating blood and brain extracellular fluid, the blood-brain barrier (BBB) is the protection layer that blocks most foreign drugs. Thus the ability of a drug to penetrate the barrier to deliver to the site of action forms a crucial challenge in development of drugs for central nervous system.\n" +
      "Question: Given a drug SMILES string, predict whether it\n" +
      "(A) does not cross the BBB (B) crosses the BBB\n" +
      "Drug SMILES: {Drug SMILES}\n" +
      "Answer:",
    positive: "B",
    positiveLabel: "yes",
    negativeLabel: "no",
  },
  {
    name: "hia",
    label: "Human Intestinal Absorption",
    prompt:
      "Instructions: Answer the following question about drug properties.\n" +
      "Context: When a drug is orally administered, it needs to be absorbed from the human gastrointestinal system into the bloodstream of the human body. This ability of absorption is called human intestinal absorption (HIA) and it is crucial for a drug to be delivered to the target.\n" +
      "Question: Given a drug SMILES string, predict whether it\n" +
      "(A) cannot be absorbed (B) can be absorbed\n" +
      "Drug SMILES: {Drug SMILES}\n" +
      "Answer:",
    positive: "B",
    positiveLabel: "absorbed",
    negativeLabel: "not absorbed",
  },
  {
    name: "herg",
    label: "hERG Blocking",
    prompt:
      "Instructions: Answer the following question about drug properties.\n" +
      "Context: Human ether-à-go-go related gene (hERG) is crucial for the coordination of the heart's beating. Thus, if a drug blocks the hERG, it could lead to severe adverse effects. Therefore, reliable prediction of hERG liability in the early stages of drug design is quite important to reduce the risk of cardiotoxicity-related attritions in the later development stages.\n" +
      "Question: Given a drug SMILES string, predict whether it\n" +
      "(A) does not block hERG (B) blocks hERG\n" +
      "Drug SMILES: {Drug SMILES}\n" +
      "Answer:",
    positive: "B",
    positiveLabel: "blocker",
    negativeLabel: "non-blocker",
  },
  {
    name: "cyp3a4",
    label: "CYP3A4 Inhibition",
    prompt:
      "Instructions: Answer the following question about drug properties.\n" +
      "Context: The CYP P450 genes are involved in the formation and breakdown (metabolism) of various molecules and chemicals within cells. Specifically, CYP3A4 is an important enzyme in the body, mainly found in the liver and in the intestine. It oxidizes small foreign organic molecules (xenobiotics), such as toxins or drugs, so that they can be removed from the body.\n" +
      "Question: Given a drug SMILES string, predict whether it\n" +
      "(A) does not inhibit CYP3A4 (B) inhibits CYP3A4\n" +
      "Drug SMILES: {Drug SMILES}\n" +
      "Answer:",
    positive: "B",
    positiveLabel: "inhibitor",
    negativeLabel: "non-inhibitor",
  },
  {
    name: "ames",
    label: "Ames Mutagenicity",
    prompt:
      "Instructions: Answer the following question about drug properties.\n" +
      "Context: Mutagenicity means the ability of a drug to induce genetic alterations. Drugs that can cause damage to the DNA can result in cell death or other severe adverse effects. Nowadays, the most widely used assay for testing the mutagenicity of compounds is the Ames experiment which was invented by a professor named Ames. The Ames test is a short-term bacterial reverse mutation assay detecting a large number of compounds which can induce genetic damage and frameshift mutations.\n" +
      "Question: Given a drug SMILES string, predict whether it\n" +
      "(A) is not mutagenic (B) is mutagenic\n" +
      "Drug SMILES: {Drug SMILES}\n" +
      "Answer:",
    positive: "B",
    positiveLabel: "mutagenic",
    negativeLabel: "non-mutagenic",
  },
  {
    name: "dili",
    label: "Drug-Induced Liver Injury",
    prompt:
      "Instructions: Answer the following question about drug properties.\n" +
      "Context: Drug-induced liver injury (DILI) is fatal liver disease caused by drugs and it has been the single most frequent cause of safety-related drug marketing withdrawals for the past 50 years (e.g. iproniazid, ticrynafen, benoxaprofen). \n" +
      "Question: Given a drug SMILES string, predict whether it\n" +
      "(A) cannot cause DILI (B) can cause DILI\n" +
      "Drug SMILES: {Drug SMILES}\n" +
      "Answer:",
    positive: "B",
    positiveLabel: "yes",
    negativeLabel: "no",
  },
] as const;

/**
 * Parse a binary (A)/(B) prediction from TxGemma-predict output.
 * Returns true if the positive class was predicted, false if negative, null if unparseable.
 *
 * TxGemma-predict outputs are typically 1-3 tokens: "(A)", "(B)", "A", "B".
 * This parser handles case variance and surrounding text.
 */
export function parseBinaryPrediction(raw: string, positiveClass: string): boolean | null {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return null;

  const negativeClass = positiveClass === "B" ? "A" : "B";

  // Check for explicit (A)/(B) markers first (most reliable)
  if (trimmed.includes(`(${positiveClass})`)) return true;
  if (trimmed.includes(`(${negativeClass})`)) return false;

  // Fallback: check if response starts with or is just the class letter
  if (trimmed === positiveClass || trimmed.startsWith(`${positiveClass} `) || trimmed.startsWith(`${positiveClass}\n`)) return true;
  if (trimmed === negativeClass || trimmed.startsWith(`${negativeClass} `) || trimmed.startsWith(`${negativeClass}\n`)) return false;

  return null;
}

export const predictAdmet = defineTool({
  name: "predict_admet",
  description:
    "Predict ADMET (Absorption, Distribution, Metabolism, Excretion, Toxicity) properties for a molecule. Returns AI-predicted risk assessments for key safety endpoints including BBB penetration, intestinal absorption, hERG inhibition, CYP3A4 inhibition, Ames mutagenicity, and DILI risk.",
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

    // Step 2: Run TxGemma-predict for each ADMET endpoint (batched via Promise.all)
    // Each call uses the TDC prompt format the model was trained on.
    const predictions: Record<string, string> = {};
    let txgemma_used = false;

    const results = await Promise.all(
      ADMET_ENDPOINTS.map(async (endpoint) => {
        const prompt = endpoint.prompt.replace("{Drug SMILES}", input.smiles);
        try {
          const raw = await ctx.ollama.generate(prompt, {
            model: TXGEMMA_MODEL,
            temperature: 0,
            maxTokens: 10,
          });
          const parsed = parseBinaryPrediction(raw, endpoint.positive);
          if (parsed !== null) {
            return { name: endpoint.name, label: parsed ? endpoint.positiveLabel : endpoint.negativeLabel };
          }
          return { name: endpoint.name, label: null };
        } catch {
          return { name: endpoint.name, label: null };
        }
      }),
    );

    for (const r of results) {
      if (r.label !== null) {
        predictions[r.name] = r.label;
        txgemma_used = true;
      }
    }

    // Step 3: Build ADMET summary (TxGemma predictions or rule-based fallback)
    let admet: Record<string, unknown>;

    if (txgemma_used) {
      admet = {
        bbb_penetration: predictions.bbb ?? "unknown",
        intestinal_absorption: predictions.hia ?? "unknown",
        herg_inhibition: predictions.herg ?? "unknown",
        cyp3a4_inhibition: predictions.cyp3a4 ?? "unknown",
        ames_mutagenicity: predictions.ames ?? "unknown",
        dili_risk: predictions.dili ?? "unknown",
      };
    } else {
      ctx.log.warn("TxGemma not available — using rule-based ADMET fallback");
      admet = {
        bbb_penetration: (props.tpsa ?? 0) < 90 && (props.molecular_weight ?? 0) < 450 ? "likely" : "unlikely",
        intestinal_absorption: (props.tpsa ?? 0) < 140 ? "likely" : "unlikely",
        herg_inhibition: (props.logp ?? 0) > 3.7 ? "possible" : "unlikely",
        cyp3a4_inhibition: "unknown",
        ames_mutagenicity: "unknown",
        dili_risk: "unknown",
        note: "Rule-based fallback — TxGemma predictions unavailable",
      };
    }

    // Step 4: MedGemma interpretation of combined results
    const { interpretation, model_used: medgemma_used } = await interpretWithMedGemma(
      ctx,
      { smiles: input.smiles, physicochemical: props, admet },
      "Synthesize these ADMET predictions for clinical relevance. " +
        "Comment on the overall safety profile, key risks (hERG, DILI, mutagenicity), " +
        "and suitability for oral administration (absorption, BBB). " +
        "Note any endpoints predicted as 'unknown' that need experimental validation.",
    );

    return {
      success: true,
      data: {
        smiles: input.smiles,
        physicochemical: props,
        admet,
        interpretation,
        model_used: txgemma_used || medgemma_used,
      },
    };
  },
});
