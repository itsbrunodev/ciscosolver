import ollama from "ollama";

import { LLM_MODEL } from "./constants";

export async function llmPickOption(
  question: string,
  options: string[],
  hint?: string,
): Promise<{ index: number; reason: string }> {
  const optionList = options.map((o, i) => `[${i}] ${o}`).join("\n");

  const hintBlock = hint
    ? `\nVERIFIED ANSWER (from exam dump, may be in English): "${hint}"\nUse this as a strong signal. Mentally translate the Hungarian options to match it.\n`
    : "";

  const prompt =
    "You are a Cisco CCNA exam expert. The question may be in Hungarian — " +
    "technical terms (VLAN, SVI, Trunk, subinterface, routing, etc.) are the same in both languages.\n\n" +
    `QUESTION: ${question}\n` +
    `${hintBlock}\n` +
    `OPTIONS:\n${optionList}\n\n` +
    `Think step-by-step, then output ONLY valid JSON: {"index": <number 0-based>, "reason": "<one sentence>"}`;

  try {
    const response = await ollama.chat({
      model: LLM_MODEL,
      format: "json",
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0.0, num_ctx: 2048 },
    });
    const parsed = JSON.parse(response.message.content);
    if (typeof parsed.index !== "number") throw new Error("bad index");
    return parsed;
  } catch (e) {
    console.warn("[LLM] Parse error, defaulting to index 0:", e);
    return { index: 0, reason: "LLM parse error fallback" };
  }
}

export async function llmPickMultiple(
  question: string,
  options: string[],
  count: number,
  hint?: string,
): Promise<{ indices: number[]; reason: string }> {
  const optionList = options.map((o, i) => `[${i}] ${o}`).join("\n");

  const hintBlock = hint
    ? // "Strong signal" wording is too weak — the LLM overrides it with its own
      // reasoning. When a DB hint is present it IS the answer; the only task is
      // translating it to the user's language options.
      `\nVERIFIED CORRECT ANSWERS (from official exam dump — treat as ground truth, do NOT override): "${hint}"\nYour only task is to find which ${count} options below match these answers. Mentally translate if needed.\n`
    : "";

  const prompt =
    "You are a Cisco CCNA exam expert. The question may be in Hungarian — " +
    "technical terms (VLAN, SVI, Trunk, subinterface, routing, etc.) are the same in both languages.\n\n" +
    `QUESTION: ${question}\n` +
    `${hintBlock}\n` +
    `OPTIONS:\n${optionList}\n\n` +
    `Choose exactly ${count} correct options. ` +
    `Output ONLY valid JSON: {"indices": [<${count} 0-based numbers>], "reason": "<one sentence>"}`;

  try {
    const response = await ollama.chat({
      model: LLM_MODEL,
      format: "json",
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0.0, num_ctx: 2048 },
    });
    const parsed = JSON.parse(response.message.content);
    if (!Array.isArray(parsed.indices)) throw new Error("bad indices");

    // Hard clamp — the LLM sometimes returns more items than requested
    if (parsed.indices.length > count) {
      console.warn(
        `[LLM] Multi-pick returned ${parsed.indices.length} indices, expected ${count} — truncating`,
      );
      parsed.indices = parsed.indices.slice(0, count);
    }

    return parsed;
  } catch (e) {
    console.warn("[LLM] Multi-pick parse error:", e);
    return { indices: [], reason: "LLM parse error fallback" };
  }
}

export async function llmSolveMatching(
  question: string,
  terms: string[],
  definitions: string[],
  hint?: string,
): Promise<Array<{ term: string; definition: string }>> {
  const termList = terms.map((t, i) => `${i}: ${t}`).join("\n");
  const defList = definitions.map((d, i) => `${i}: ${d}`).join("\n");

  const hintBlock = hint
    ? `\nVERIFIED PAIRS (from exam dump, use as ground truth):\n${hint}\n`
    : "";

  const prompt =
    "You are a Cisco CCNA expert. The question and options may be in Hungarian — " +
    "answer using your CCNA knowledge regardless of language.\n\n" +
    "TASK: Match each TERM index to exactly one DEFINITION index. Every term index must appear exactly once.\n\n" +
    `QUESTION: ${question}\n` +
    `${hintBlock}\n` +
    `TERMS (index: text):\n${termList}\n\n` +
    `DEFINITIONS (index: text):\n${defList}\n\n` +
    "Output ONLY this JSON — use the integer indices, not the text:\n" +
    `{"pairs": [{"termIndex": 0, "defIndex": 2}, ...]}`;

  try {
    const response = await ollama.chat({
      model: LLM_MODEL,
      format: "json",
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0.0, num_ctx: 2048 },
    });

    const raw = JSON.parse(response.message.content);

    let arr: unknown;
    if (Array.isArray(raw)) {
      arr = raw;
    } else if (typeof raw === "object" && raw !== null) {
      arr = Object.values(raw).find((v) => Array.isArray(v));
    }

    if (!Array.isArray(arr) || arr.length === 0) {
      console.warn(
        "[LLM] Matching: no array in response:",
        JSON.stringify(raw).slice(0, 200),
      );
      return [];
    }

    return resolveMatchingIndices(arr, terms, definitions);
  } catch (e) {
    console.warn("[LLM] Matching parse error:", e);
    return [];
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function resolveMatchingIndices(
  arr: unknown[],
  terms: string[],
  definitions: string[],
): Array<{ term: string; definition: string }> {
  const result: Array<{ term: string; definition: string }> = [];
  const usedDefs = new Set<number>();

  for (const p of arr) {
    const termIdx = (p as any)?.termIndex;
    const defIdx = (p as any)?.defIndex;

    if (typeof termIdx !== "number" || typeof defIdx !== "number") {
      console.warn("[LLM] Matching: item missing indices:", JSON.stringify(p));
      continue;
    }
    if (
      termIdx < 0 ||
      termIdx >= terms.length ||
      defIdx < 0 ||
      defIdx >= definitions.length
    ) {
      console.warn(
        `[LLM] Matching: index out of range termIndex=${termIdx} defIndex=${defIdx}`,
      );
      continue;
    }
    if (usedDefs.has(defIdx)) {
      console.warn(
        `[LLM] Matching: defIndex ${defIdx} used more than once, skipping duplicate.`,
      );
      continue;
    }

    usedDefs.add(defIdx);
    result.push({ term: terms[termIdx]!, definition: definitions[defIdx]! });
  }

  if (result.length === 0) {
    console.warn("[LLM] Matching: no valid index pairs extracted");
    return [];
  }

  console.log(`[LLM] Matching: got ${result.length} pairs`);
  return result;
}
