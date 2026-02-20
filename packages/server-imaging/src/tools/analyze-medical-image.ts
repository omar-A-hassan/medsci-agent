import { z } from "zod";
import { defineTool } from "@medsci/core";
import { readFile, stat } from "node:fs/promises";

const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export const analyzeMedicalImage = defineTool({
  name: "analyze_medical_image",
  description:
    "Analyze a medical image (X-ray, CT, pathology slide, dermatology photo) using MedGemma's multimodal capabilities. Returns findings, observations, and suggested follow-up.",
  schema: z.object({
    image_path: z.string().min(1).describe("Path to the medical image file (PNG, JPEG)"),
    modality: z.enum(["chest_xray", "pathology", "dermatology", "ct", "mri", "other"])
      .describe("Type of medical image"),
    clinical_context: z.string().optional()
      .describe("Brief clinical context or question (e.g. 'rule out pneumonia')"),
  }),
  execute: async (input, ctx) => {
    // Check file size before reading
    let fileSize: number;
    try {
      const fileStat = await stat(input.image_path);
      fileSize = fileStat.size;
    } catch (err) {
      return {
        success: false,
        error: `Could not access image file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (fileSize > MAX_IMAGE_SIZE_BYTES) {
      return {
        success: false,
        error: `Image file too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Maximum: ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB.`,
      };
    }

    // Read and encode image (async to avoid blocking the event loop)
    let imageBase64: string;
    try {
      const buffer = await readFile(input.image_path);
      imageBase64 = buffer.toString("base64");
    } catch (err) {
      return {
        success: false,
        error: `Could not read image file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const modalityPrompts: Record<string, string> = {
      chest_xray:
        "Analyze this chest X-ray. Describe findings including lung fields, cardiac silhouette, mediastinum, bony structures, and any abnormalities.",
      pathology:
        "Analyze this histopathology slide. Describe tissue architecture, cellular morphology, staining patterns, and any pathological findings.",
      dermatology:
        "Analyze this dermatological image. Describe the lesion characteristics: shape, border, color, distribution, and morphological features.",
      ct: "Analyze this CT scan. Describe relevant anatomy and any abnormal findings.",
      mri: "Analyze this MRI scan. Describe relevant anatomy and any abnormal findings.",
      other: "Analyze this medical image. Describe what you observe and any notable findings.",
    };

    const systemPrompt = [
      "You are a medical imaging analysis assistant powered by MedGemma.",
      "Provide structured observations. Always include a disclaimer that this is AI-assisted analysis and should be reviewed by a qualified radiologist/pathologist.",
      'Respond with JSON: {"findings": [...], "impression": "...", "recommendations": [...], "disclaimer": "..."}',
    ].join(" ");

    let basePrompt = modalityPrompts[input.modality];
    if (input.clinical_context) {
      basePrompt += `\n\nClinical context: ${input.clinical_context}`;
    }
    // Prompt repetition improves non-reasoning model accuracy (arXiv:2512.14982)
    const prompt = `${basePrompt}\n\nTo reiterate:\n${basePrompt}`;

    let analysis: Record<string, unknown>;
    let model_used = true;
    try {
      analysis = await ctx.ollama.generateJson<Record<string, unknown>>(prompt, {
        system: systemPrompt,
        temperature: 0.2,
        maxTokens: 1000,
        images: [imageBase64],
      });
    } catch {
      model_used = false;
      // Fallback: if JSON parsing fails, wrap the raw text response
      try {
        const raw = await ctx.ollama.generate(prompt, {
          system: systemPrompt,
          temperature: 0.2,
          maxTokens: 1000,
          images: [imageBase64],
        });
        model_used = true;
        analysis = {
          findings: [raw.trim()],
          impression: "See findings above",
          recommendations: ["Review by qualified specialist recommended"],
          disclaimer: "AI-assisted analysis — not a substitute for professional medical interpretation.",
        };
      } catch {
        analysis = {
          findings: [],
          impression: "MedGemma unavailable",
          recommendations: ["Review by qualified specialist recommended"],
          disclaimer: "AI-assisted analysis — not a substitute for professional medical interpretation.",
        };
      }
    }

    return {
      success: true,
      data: {
        modality: input.modality,
        image_path: input.image_path,
        clinical_context: input.clinical_context,
        analysis,
        model_used,
      },
    };
  },
});
