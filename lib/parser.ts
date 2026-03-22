import * as cheerio from "cheerio";
import sharp from "sharp";

import { generateContentWithRetry, MODEL_ID } from "./gemini";
import type { Question } from "./types";

const questionSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      question: { type: "STRING" },
      type: {
        type: "STRING",
        enum: ["single-choice", "multiple-choice", "matching"],
      },
      options: {
        type: "ARRAY",
        items: { type: "STRING" },
      },
      correctAnswer: {
        type: "ARRAY",
        items: { type: "STRING" },
      },
      matchingPairs: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            term: { type: "STRING" },
            definition: { type: "STRING" },
          },
          required: ["term", "definition"],
        },
      },
      explanation: { type: "STRING" },
      imageUrl: { type: "STRING", nullable: true },
      sourceUrl: { type: "STRING" },
      confidence: { type: "NUMBER" },
    },
    required: [
      "id",
      "question",
      "type",
      "options",
      "correctAnswer",
      "matchingPairs",
      "sourceUrl",
      "confidence",
    ],
  },
};

export async function parseQuestions(
  html: string,
  sourceUrl: string,
): Promise<Question[]> {
  const $ = cheerio.load(html);

  $(
    "script, style, iframe, nav, footer, .sidebar, .comments, .adsbygoogle, .shareit, #respond, .bottomad, .topad",
  ).remove();

  let mainContent = "";
  if ($(".dwqa-question-item").length > 0) {
    mainContent = $(".dwqa-question-item").html() || "";
  } else if ($(".entry-content").length > 0) {
    mainContent = $(".entry-content").html() || "";
  } else {
    mainContent = $("body").html() || "";
  }

  const $cleaned = cheerio.load(mainContent);
  const imageParts: Array<{ inlineData: { data: string; mimeType: string } }> =
    [];
  const imageUrlMapping: string[] = [];

  const imgs = $cleaned("img").toArray();

  for (let i = 0; i < imgs.length; i++) {
    const el = imgs[i];
    const src = $(el).attr("data-src") || $(el).attr("src");

    if (!src) continue;

    try {
      const absoluteUrl =
        src.startsWith("/") || src.startsWith("http")
          ? new URL(src, sourceUrl).toString()
          : src;

      const res = await fetch(absoluteUrl, {
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());

        const optimized = await sharp(buffer)
          .resize({ width: 1024, height: 1024, fit: "inside" })
          .jpeg({ quality: 80 })
          .toBuffer();

        const placeholder = `[IMAGE_${imageParts.length}]`;

        imageParts.push({
          inlineData: {
            data: optimized.toString("base64"),
            mimeType: "image/jpeg",
          },
        });

        imageUrlMapping.push(`${placeholder}: ${absoluteUrl}`);

        $(el).replaceWith(placeholder);
      }
    } catch (e) {
      console.warn(`[Parser] Failed to fetch image ${src}: ${e}`);
    }
  }

  const cleanedHtml = $cleaned.html() || "";

  const prompt = `
You are an expert Cisco CCNA networking exam parser.
Extract all questions from the provided HTML.
For each question, extract its text, type, options, correct answers, and explanation.

IMPORTANT INSTRUCTIONS:
1. Pay attention to inline CSS styles (like \`color: red\`) or CSS classes (like \`correct_answer\`) to determine the correct answers.
2. IMAGES: The attached images correspond to the placeholders in the HTML. Here are their original URLs:
${imageUrlMapping.length > 0 ? imageUrlMapping.join("\n") : "No images provided."}
   If a question relies on an image, set its "imageUrl" field to the EXACT URL from the list above. If no image is needed, set it to null.
3. MATCHING QUESTIONS: If a question is a "matching" question (e.g., drag and drop, or lines drawn between items), you MUST read the image and extract the pairs into "matchingPairs".
   - "term": Extract ONLY the exact text of the item. DO NOT include visual descriptions, line routing notes (e.g., "A in image", "connects to"), or reasoning.
   - "definition": Extract ONLY the exact text of the matching definition. DO NOT include reasoning.
   - Example GOOD Pair: { "term": "Dynamic desirable", "definition": "Actively attempts to convert the link to a trunk" }
   - Example BAD Pair: { "term": "Dynamic desirable (B in image connects to...)", "definition": "" }
4. Set "confidence" to 1.0.
5. Return a JSON array of Question objects.
6. Use the exact sourceUrl provided: "${sourceUrl}"

HTML Content:
${cleanedHtml}
`;

  try {
    const response = await generateContentWithRetry({
      model: MODEL_ID,
      contents: [{ role: "user", parts: [...imageParts, { text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: questionSchema,
        temperature: 0.1,
      },
    });

    if (response.usageMetadata) {
      const inTokens = response.usageMetadata.promptTokenCount || 0;
      const outTokens = response.usageMetadata.candidatesTokenCount || 0;
      const cost =
        (inTokens / 1_000_000) * 0.25 + (outTokens / 1_000_000) * 1.5;

      console.log(
        `[Cost] URL: ${sourceUrl.substring(
          0,
          40,
        )}... | In: ${inTokens} | Out: ${outTokens} | Est. Cost: $${cost.toFixed(5)}`,
      );
    }

    const textOutput = response.text;

    if (!textOutput) return [];

    const questions: Question[] = JSON.parse(textOutput);

    return questions.map((q) => ({
      ...q,
      id: q.id.startsWith("q-")
        ? q.id
        : `q-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      sourceUrl: sourceUrl,
    }));
  } catch (error) {
    console.error(`[Parser] Gemini extraction failed for ${sourceUrl}:`, error);

    return [];
  }
}
