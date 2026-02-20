import { z } from "zod";
import { defineTool } from "@medsci/core";

const ALPHAFOLD_BASE = "https://alphafold.ebi.ac.uk/api";

export const predictStructure = defineTool({
  name: "predict_structure",
  description:
    "Retrieve an AlphaFold-predicted protein structure by UniProt accession. Returns confidence scores (pLDDT), predicted aligned error, and download links for PDB/mmCIF files.",
  schema: z.object({
    uniprot_id: z.string().min(1).describe("UniProt accession (e.g. 'P69905' for human hemoglobin alpha)"),
  }),
  execute: async (input, ctx) => {
    const url = `${ALPHAFOLD_BASE}/prediction/${input.uniprot_id}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 404) {
        return {
          success: false,
          error: `No AlphaFold prediction found for ${input.uniprot_id}`,
        };
      }
      return { success: false, error: `AlphaFold API returned ${res.status}` };
    }

    const predictions = (await res.json()) as any[];
    if (!predictions.length) {
      return { success: false, error: "No predictions returned" };
    }

    const pred = predictions[0];
    return {
      success: true,
      data: {
        uniprot_id: input.uniprot_id,
        entry_id: pred.entryId,
        gene: pred.gene,
        organism: pred.organismScientificName,
        model_url_pdb: pred.pdbUrl,
        model_url_cif: pred.cifUrl,
        pae_image_url: pred.paeImageUrl,
        confidence_url: pred.confidenceUrl,
        model_version: pred.latestVersion,
        sequence_length: pred.uniprotEnd - pred.uniprotStart + 1,
        mean_plddt: pred.globalMetricValue,
      },
    };
  },
});
