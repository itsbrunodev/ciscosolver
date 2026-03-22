// file path: lib/solver.ts
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "@huggingface/transformers";
import { type AnyOrama, create, search } from "@orama/orama";
import { restoreFromFile } from "@orama/plugin-data-persistence/server";
import ollama from "ollama";

import { buildCacheKey, embeddingCache, solveResultCache } from "./cache";
import type { Question } from "./types";

const INDEX_PATH = "data/vectors.msp";
const modelPath = path.join(process.cwd(), "model");
// const EMBEDDING_MODEL = "Xenova/bge-m3";
const EMBEDDING_MODEL = modelPath;

// How many candidates to retrieve from the vector index before re-ranking.
// Wider net → re-ranking has more to work with. Don't filter here; filter after.
const DEFAULT_RETRIEVAL_LIMIT = 8;

// The initial ANN search threshold. Deliberately low (0.55) so borderline
// multilingual queries aren't discarded before re-ranking gets a shot.
// Re-ranking + the confidence gate below are the real accuracy filters.
const DEFAULT_MIN_QUESTION_SIMILARITY = 0.55;

// Weight given to the question-only similarity score during re-ranking.
const RERANK_QUESTION_WEIGHT = 0.4;

// Minimum cosine similarity for answer-to-option mapping.
const DEFAULT_MIN_PAIR_SIMILARITY = 0.5;

// Below this combined re-rank score, the vector hit is considered uncertain
// and the LLM is consulted as a cross-check / tiebreaker.
const LLM_CONSULT_THRESHOLD = 0.78;

// Below this combined score, we skip the vector hit entirely and use LLM only.
const LLM_ONLY_THRESHOLD = 0.65;

// When the top two answer options are within this margin in cosine similarity,
// trust the LLM to disambiguate rather than auto-picking the higher one.
const ANSWER_AMBIGUITY_MARGIN = 0.04;

// Ollama model for fallback and disambiguation. qwen2.5:7b at q4_K_M fits in
// ~4.1 GB VRAM and is substantially better at CCNA reasoning than 3b.
const LLM_MODEL = "qwen2.5:7b-instruct-q4_K_M";

// --- Interfaces ---

interface SolveRequest {
  question: string;
  options?: string[];
  terms?: string[];
  definitions?: string[];
  overrides: {
    minQuestionSimilarity?: number;
    minAnswerSimilarity?: number;
    candidateCount?: number;
    bypassCache?: boolean;
  };
}

interface SolveResult {
  answers?: string[];
  matchingPairs?: Array<{ term: string; definition: string }>;
  confidence: number;
  source: "db" | "llm" | "db+llm" | "not_found" | "cache";
  explanation?: string;
}

// --- Helpers ---

function cos_sim(A: number[], B: number[]): number {
  // Vectors from BGE-M3 are already L2-normalised (normalize: true),
  // so the dot product equals cosine similarity.
  let dot = 0;
  const len = Math.min(A.length, B.length);
  for (let i = 0; i < len; i++) dot += (A[i] ?? 0) * (B[i] ?? 0);
  return dot;
}

function cleanOptionText(text: string): string {
  if (!text) return "";
  return text
    .trim()
    .replace(/^[A-Za-z][.)]\s*|^-\s*|^\s*\d+[.)]\s*/, "")
    .trim();
}

function buildQueryText(
  question: string,
  options?: string[],
  terms?: string[],
  definitions?: string[],
): string {
  const q = question.trim();
  const isMatching = Array.isArray(terms) && terms.length > 0;

  if (isMatching) {
    const termsStr = (terms ?? []).join(" ");
    const defsStr = (definitions ?? []).join(" ");
    return `${q} ${termsStr} ${defsStr}`.trim();
  }

  const cleanedOptions = (options ?? []).map(cleanOptionText).join(" ");
  return `${q} ${cleanedOptions}`.trim();
}

// --- LLM Helpers ---

/**
 * Ask the LLM to pick the correct option index.
 * Used as a fallback (no DB match) and as a disambiguator (low confidence).
 *
 * @param hint  Optional English answer text from the DB to steer the model.
 */
async function llmPickOption(
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

/**
 * Ask the LLM to produce matching pairs when vector retrieval fails or is low confidence.
 *
 * The LLM returns indices (termIndex, defIndex) rather than text, then we resolve
 * them to the original strings server-side. This avoids the model echoing back the
 * "[N] text" format from the prompt, and means we always return exactly the text
 * the frontend sent us — no reformatting, no brackets, no hallucinated wording.
 *
 * HINT SAFETY: Only pass a hint when the DB hit is a genuine matching question.
 */
async function llmSolveMatching(
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

    // Extract array — handle bare array or any wrapped-object form
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

    const result: Array<{ term: string; definition: string }> = [];
    const usedDefs = new Set<number>();

    for (const p of arr as unknown[]) {
      const termIdx = (p as any)?.termIndex;
      const defIdx = (p as any)?.defIndex;

      if (typeof termIdx !== "number" || typeof defIdx !== "number") {
        console.warn(
          "[LLM] Matching: item missing indices:",
          JSON.stringify(p),
        );
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
          `[LLM] Matching: defIndex ${defIdx} used more than once — skipping duplicate`,
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
  } catch (e) {
    console.warn("[LLM] Matching parse error:", e);
    return [];
  }
}

// --- Misclassified DB Question Recovery ---

/**
 * Attempts to extract (term, definition) pairs from a DB question that was
 * incorrectly classified as single-choice during scraping.
 *
 * This happens when the scraper encounters a matching question whose answer
 * markup doesn't trigger the matching parser, resulting in:
 *   - type: "single-choice"
 *   - matchingPairs: []
 *   - correctAnswer: []  (or populated with the combined "desc – TERM" strings)
 *   - options: ["description – TERM", ...] or explanation containing the pairs
 *
 * Recovery strategies (tried in order):
 *
 *   1. OPTIONS DASH SPLIT: Each option contains " – " or " - " separating the
 *      description from the short term. E.g.:
 *        "a client initiating a message to find a DHCP server – DHCPDISCOVER"
 *      Split on the separator, use the longer part as term, shorter as definition.
 *
 *   2. EXPLANATION TEXT PARSE: The explanation sometimes repeats all pairs in a
 *      structured form. Same dash-split heuristic applied line by line.
 *
 * Returns [] if neither strategy yields at least 2 pairs (not enough signal).
 */
function recoverPairsFromMisclassified(
  dbQuestion: Question,
): Array<{ term: string; definition: string }> {
  // Separators used on itexamanswers.net: em-dash, en-dash, plain hyphen with spaces
  const SPLIT_RE = /\s+[–—-]{1,2}\s+/;

  function splitOption(
    text: string,
  ): { term: string; definition: string } | null {
    const parts = text.split(SPLIT_RE);
    if (parts.length < 2) return null;
    // Take the first two parts only (guards against nested dashes)
    const a = parts[0]!.trim();
    const b = parts.slice(1).join(" – ").trim();
    if (!a || !b) return null;
    // Shorter part is almost always the protocol abbreviation (definition),
    // longer part is the human-readable description (term).
    return a.length >= b.length
      ? { term: a, definition: b }
      : { term: b, definition: a };
  }

  // Strategy 1: parse options
  if (dbQuestion.options.length >= 2) {
    const pairs = dbQuestion.options
      .map(splitOption)
      .filter((p): p is { term: string; definition: string } => p !== null);
    if (pairs.length >= 2) {
      console.log(
        `[Recovery] Extracted ${pairs.length} pairs from options of misclassified question "${dbQuestion.id}"`,
      );
      return pairs;
    }
  }

  // Strategy 2: parse explanation text line by line
  if (dbQuestion.explanation) {
    const lines = dbQuestion.explanation.split(/[\n;]+/);
    const pairs = lines
      .map(splitOption)
      .filter((p): p is { term: string; definition: string } => p !== null);
    if (pairs.length >= 2) {
      console.log(
        `[Recovery] Extracted ${pairs.length} pairs from explanation of misclassified question "${dbQuestion.id}"`,
      );
      return pairs;
    }
  }

  return [];
}

// --- SolverService ---

export class SolverService {
  private static instance: SolverService;
  private orama: AnyOrama | null = null;
  private extractor: any;
  private isReady = false;

  private constructor() {}

  public static getInstance(): SolverService {
    if (!SolverService.instance) {
      SolverService.instance = new SolverService();
    }
    return SolverService.instance;
  }

  public async init() {
    if (this.isReady) return;

    console.log("🚀 Initializing Solver Service...");

    this.extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      // OFFLINE ONLY
      local_files_only: true,
    });

    if (fs.existsSync(INDEX_PATH)) {
      console.log("📦 Loading Vector Index from disk...");
      this.orama = await restoreFromFile("binary", INDEX_PATH);
    } else {
      console.error(
        "❌ Vector Index not found! Please run 'bun run ingest' first.",
      );
      this.orama = (await create({
        schema: {
          id: "string",
          text: "string",
          embedding: "vector[1024]",
          data: "string",
        },
      })) as unknown as AnyOrama;
    }
    this.isReady = true;
    console.log("✅ Solver Ready!");
  }

  // --- Embedding (with cache) ---

  private async getEmbedding(text: string): Promise<number[]>;
  private async getEmbedding(text: string[]): Promise<number[][]>;
  private async getEmbedding(
    text: string | string[],
  ): Promise<number[] | number[][]> {
    if (typeof text === "string") return this.embedSingle(text);
    return this.embedBatch(text);
  }

  private async embedSingle(text: string): Promise<number[]> {
    const cached = embeddingCache.get(text);
    if (cached) return cached;

    const result = await this.extractor(text, {
      pooling: "cls",
      normalize: true,
    });
    const vector: number[] = Array.from(result.data as Float32Array);
    embeddingCache.set(text, vector);
    return vector;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const vectors: (number[] | null)[] = texts.map(
      (t) => embeddingCache.get(t) ?? null,
    );

    const missedIndices = vectors
      .map((v, i) => (v === null ? i : null))
      .filter((i): i is number => i !== null);

    if (missedIndices.length > 0) {
      const missedTexts = missedIndices.map((i) => texts[i] as string);
      const result = await this.extractor(missedTexts, {
        pooling: "cls",
        normalize: true,
      });

      for (let k = 0; k < missedIndices.length; k++) {
        const idx = missedIndices[k] as number;
        const vector: number[] = Array.from(
          (result.data as Float32Array).slice(k * 1024, (k + 1) * 1024),
        );
        embeddingCache.set(texts[idx] as string, vector);
        vectors[idx] = vector;
      }
    }

    return vectors as number[][];
  }

  // --- Re-ranking ---

  private async reRankHits(
    hits: Array<{
      score: number;
      document: { data: string; [k: string]: unknown };
    }>,
    questionVec: number[],
  ): Promise<{ hit: (typeof hits)[0]; combinedScore: number }> {
    const dbQuestions: string[] = hits.map((h) => {
      const q: Question = JSON.parse(String(h.document.data));
      return q.question;
    });

    const dbQuestionVecs = await this.getEmbedding(dbQuestions);

    let bestHit = hits[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i]!;
      const qSim = cos_sim(questionVec, dbQuestionVecs[i]!);
      const combinedScore =
        hit.score * (1 - RERANK_QUESTION_WEIGHT) +
        qSim * RERANK_QUESTION_WEIGHT;

      if (combinedScore > bestScore) {
        bestScore = combinedScore;
        bestHit = hit;
      }
    }

    return { hit: bestHit, combinedScore: bestScore };
  }

  // --- Answer Mapping ---

  /**
   * Builds a bijective mapping from DB options to user options using a greedy
   * maximum-weight matching over the full cosine similarity matrix.
   *
   * WHY BIJECTION:
   * Independent per-answer mapping fails when options differ by a prefix/suffix
   * (e.g. "interface" vs "subinterface" → both score high against "Az interfészen").
   * When we force a one-to-one assignment across the *entire option set*, the
   * semantically closest unambiguous pair gets locked in first, which pushes
   * the near-duplicate to its correct counterpart.
   *
   * Example (this exact bug):
   *   DB:   ["to the interface", "to the subinterface", "to the SVI", "to the VLAN"]
   *   User: ["Az interfészen",   "Az SVI-n",            "Az alinterfészen", "A VLAN-on"]
   *
   *   Without bijection: "to the subinterface" scores highest against "Az interfészen"
   *                       → wrong answer selected.
   *   With bijection:    "to the interface" ↔ "Az interfészen" is locked first (highest
   *                       global pair), leaving "to the subinterface" → "Az alinterfészen".
   *
   * Returns: Map<dbOptionIndex, userOptionIndex>
   */
  private async buildOptionBijection(
    dbOptions: string[],
    userOptions: string[],
  ): Promise<Map<number, number>> {
    const cleanedDb = dbOptions.map(cleanOptionText);
    const cleanedUser = userOptions.map(cleanOptionText);

    const [dbVecs, userVecs] = await Promise.all([
      this.getEmbedding(cleanedDb),
      this.getEmbedding(cleanedUser),
    ]);

    return this.greedyBijectiveMatch(
      dbVecs as number[][],
      userVecs as number[][],
      dbOptions,
      userOptions,
      "Option",
    );
  }

  /**
   * Maps DB correct answers to user options.
   *
   * Strategy:
   *   1. Build a bijective option-set mapping (solves interface/subinterface class of bugs).
   *   2. For each DB correct answer, find its index in the DB option list.
   *   3. Look up the corresponding user option via the bijection.
   *   4. Fall back to independent cosine similarity only when the DB answer
   *      isn't in the DB option list (shouldn't happen with well-scraped data).
   */
  private async mapAnswersToUserLanguage(
    dbAnswers: string[],
    dbAllOptions: string[],
    userOptions: string[],
    originalQuestion: string,
    minPairSimilarity = DEFAULT_MIN_PAIR_SIMILARITY,
  ): Promise<string[]> {
    if (dbAnswers.length === 0 || userOptions.length === 0) return [];

    // ── Path A: Bijective option-set mapping ─────────────────────────────────
    // Only usable when the DB question carries a full option list.
    if (dbAllOptions.length > 0 && dbAllOptions.length === userOptions.length) {
      const bijection = await this.buildOptionBijection(
        dbAllOptions,
        userOptions,
      );
      const mappedAnswers: string[] = [];

      for (const dbAnswer of dbAnswers) {
        // Find this answer's position in the DB option list
        const cleanAnswer = cleanOptionText(dbAnswer);
        const dbOptionIndex = dbAllOptions.findIndex(
          (opt) => cleanOptionText(opt) === cleanAnswer,
        );

        if (dbOptionIndex !== -1) {
          const userIdx = bijection.get(dbOptionIndex);
          if (userIdx !== undefined) {
            const chosen = userOptions[userIdx];
            if (typeof chosen === "string") {
              console.log(
                `[AnswerMap] "${dbAnswer}" → "${chosen}" (via bijection index ${dbOptionIndex}→${userIdx})`,
              );
              mappedAnswers.push(chosen);
              continue;
            }
          }
        }

        // DB answer wasn't found verbatim in options — fall through to direct similarity
        console.warn(
          `[AnswerMap] "${dbAnswer}" not found in DB options list — falling back to direct similarity`,
        );
        const fallback = await this.mapSingleAnswerDirect(
          dbAnswer,
          userOptions,
          originalQuestion,
          minPairSimilarity,
        );
        if (fallback) mappedAnswers.push(fallback);
      }

      return [...new Set(mappedAnswers)];
    }

    // ── Path B: Option counts differ (different question variant) ────────────
    // The bijection assumption breaks — fall back to direct per-answer similarity.
    console.warn(
      `[AnswerMap] DB has ${dbAllOptions.length} options, user has ${userOptions.length} — ` +
        "option counts differ, using direct similarity fallback",
    );
    const results: string[] = [];
    for (const ans of dbAnswers) {
      const match = await this.mapSingleAnswerDirect(
        ans,
        userOptions,
        originalQuestion,
        minPairSimilarity,
      );
      if (match) results.push(match);
    }
    return [...new Set(results)];
  }

  /**
   * Direct cosine similarity mapping for a single answer → options.
   * Used as a fallback when bijection isn't applicable.
   * Still asks the LLM when two options are within ANSWER_AMBIGUITY_MARGIN.
   */
  private async mapSingleAnswerDirect(
    dbAnswer: string,
    userOptions: string[],
    originalQuestion: string,
    minPairSimilarity: number,
  ): Promise<string | null> {
    const cleanedDb = cleanOptionText(dbAnswer);
    const cleanedUser = userOptions.map(cleanOptionText);

    const [dbVec, userVecs] = await Promise.all([
      this.getEmbedding(cleanedDb),
      this.getEmbedding(cleanedUser),
    ]);

    const scores = userVecs.map((uv, j) => ({
      idx: j,
      sim: cos_sim(dbVec, uv as number[]),
    }));
    scores.sort((a, b) => b.sim - a.sim);

    const best = scores[0]!;
    const second = scores[1];

    if (
      second &&
      best.sim - second.sim < ANSWER_AMBIGUITY_MARGIN &&
      best.sim > minPairSimilarity
    ) {
      console.log(
        `[Disambiguate] Options [${best.idx}] (${best.sim.toFixed(3)}) and ` +
          `[${second.idx}] (${second.sim.toFixed(3)}) are too close — asking LLM`,
      );
      const { index } = await llmPickOption(
        originalQuestion,
        userOptions,
        dbAnswer,
      );
      return userOptions[index] ?? null;
    }

    if (best.sim < minPairSimilarity) {
      console.warn(
        `⚠️ Low pair similarity (${best.sim.toFixed(3)}) for "${dbAnswer}" → "${userOptions[best.idx]}"`,
      );
    }

    return userOptions[best.idx] ?? null;
  }

  /**
   * Maps DB (term, definition) pairs to user (term, definition) pairs.
   *
   * THE FUNDAMENTAL PROBLEM THIS SOLVES:
   *
   * 1. The exam shuffles both lists independently. userTerms[i] and
   *    userDefinitions[i] are NOT a pre-paired slot — they're two separate
   *    shuffled columns. The task is to find which userDefinition belongs to
   *    which userTerm. Treating them as pre-paired and running two independent
   *    bijections is structurally wrong.
   *
   * 2. The DB sometimes stores columns with swapped roles:
   *    DB: term="Cisco implementation of IEEE 802.1D", definition="PVST"
   *    User: terms=["PVST",...], definitions=["Az IEEE 802.1D Cisco..."]
   *    Comparing DB.term vs userTerms is description vs abbreviation — garbage.
   *
   * THE CORRECT ALGORITHM:
   *
   *   We want a bijection f: userTerms -> userDefinitions, guided by DB pairs.
   *
   *   For each candidate assignment (userTerm_j, userDefinition_k):
   *     Find the DB pair that best explains this assignment, in EITHER orientation:
   *       normal:  sim(db.term, userTerm_j) + sim(db.def, userDef_k)
   *       swapped: sim(db.term, userDef_k)  + sim(db.def, userTerm_j)
   *     score[j][k] = max(normal, swapped) over all DB pairs
   *
   *   Then greedily assign j->k to maximise total score, with each j and k
   *   used at most once.
   *
   * This is orientation-agnostic, shuffle-agnostic, and produces a correct
   * (term, definition) output for every user term.
   */
  private async mapMatchingPairs(
    dbPairs: Array<{ term: string; definition: string }>,
    userTerms: string[],
    userDefinitions: string[],
    minPairSimilarity = DEFAULT_MIN_PAIR_SIMILARITY,
  ): Promise<Array<{ term: string; definition: string }>> {
    if (
      dbPairs.length === 0 ||
      userTerms.length === 0 ||
      userDefinitions.length === 0
    )
      return [];

    const dbTermTexts = dbPairs.map((p) => cleanOptionText(p.term));
    const dbDefTexts = dbPairs.map((p) => cleanOptionText(p.definition));
    const userTermTexts = userTerms.map(cleanOptionText);
    const userDefTexts = userDefinitions.map(cleanOptionText);

    // Embed all four lists in parallel
    const [dbTermVecs, dbDefVecs, userTermVecs, userDefVecs] =
      await Promise.all([
        this.getEmbedding(dbTermTexts),
        this.getEmbedding(dbDefTexts),
        this.getEmbedding(userTermTexts),
        this.getEmbedding(userDefTexts),
      ]);

    // Build score matrix: score[j][k] = best similarity for assigning
    // userTerms[j] <-> userDefinitions[k], evaluated against all DB pairs.
    const n = userTerms.length;
    const m = userDefinitions.length;

    interface Cell {
      termIdx: number; // j: index into userTerms
      defIdx: number; // k: index into userDefinitions
      score: number;
      dbIdx: number; // which DB pair best explained this cell
      swapped: boolean; // whether DB columns were swapped for best score
    }

    const cells: Cell[] = [];

    for (let j = 0; j < n; j++) {
      const ut = userTermVecs[j] as number[];
      for (let k = 0; k < m; k++) {
        const ud = userDefVecs[k] as number[];

        let bestScore = Number.NEGATIVE_INFINITY;
        let bestDb = 0;
        let bestSwapped = false;

        for (let d = 0; d < dbPairs.length; d++) {
          const dt = dbTermVecs[d] as number[];
          const dd = dbDefVecs[d] as number[];

          const normalScore = cos_sim(dt, ut) + cos_sim(dd, ud);
          const swappedScore = cos_sim(dt, ud) + cos_sim(dd, ut);

          if (normalScore >= swappedScore && normalScore > bestScore) {
            bestScore = normalScore;
            bestDb = d;
            bestSwapped = false;
          } else if (swappedScore > normalScore && swappedScore > bestScore) {
            bestScore = swappedScore;
            bestDb = d;
            bestSwapped = true;
          }
        }

        cells.push({
          termIdx: j,
          defIdx: k,
          score: bestScore,
          dbIdx: bestDb,
          swapped: bestSwapped,
        });
      }
    }

    // Greedy max-weight bipartite matching on the user side
    cells.sort((a, b) => b.score - a.score);

    const assignedTerms = new Set<number>();
    const assignedDefs = new Set<number>();
    const result: Array<{ term: string; definition: string }> = [];

    for (const { termIdx, defIdx, score, dbIdx, swapped } of cells) {
      if (assignedTerms.has(termIdx) || assignedDefs.has(defIdx)) continue;

      assignedTerms.add(termIdx);
      assignedDefs.add(defIdx);

      const avgSim = score / 2;
      const userTerm = userTerms[termIdx]!;
      const userDef = userDefinitions[defIdx]!;

      if (avgSim < minPairSimilarity) {
        console.warn(
          `⚠️ [Matching] Low similarity (avg ${avgSim.toFixed(3)}, ${swapped ? "swapped" : "normal"}): ` +
            `"${userTerm}" <-> "${userDef}" (best DB pair: "${dbPairs[dbIdx]!.term}" | "${dbPairs[dbIdx]!.definition}")`,
        );
      } else {
        console.log(
          `[Matching] "${userTerm}" <-> "${userDef}" ` +
            `(avg sim ${avgSim.toFixed(3)}, ${swapped ? "swapped" : "normal"}, ` +
            `DB: "${dbPairs[dbIdx]!.term}" | "${dbPairs[dbIdx]!.definition}")`,
        );
      }

      result.push({ term: userTerm, definition: userDef });

      if (result.length === Math.min(n, m)) break;
    }

    return result;
  }
  /**
   * Greedy maximum-weight bipartite matching over a cosine similarity matrix.
   * Returns Map<dbIndex, userIndex> — each index appears at most once on each side.
   */
  private greedyBijectiveMatch(
    dbVecs: number[][],
    userVecs: number[][],
    dbLabels: string[],
    userLabels: string[],
    tag: string,
    warnThreshold?: number,
  ): Map<number, number> {
    const matrix: Array<{ dbIdx: number; userIdx: number; sim: number }> = [];
    for (let d = 0; d < dbVecs.length; d++) {
      for (let u = 0; u < userVecs.length; u++) {
        matrix.push({
          dbIdx: d,
          userIdx: u,
          sim: cos_sim(dbVecs[d]!, userVecs[u]!),
        });
      }
    }
    matrix.sort((a, b) => b.sim - a.sim);

    const assignedDb = new Set<number>();
    const assignedUser = new Set<number>();
    const bijection = new Map<number, number>();

    for (const { dbIdx, userIdx, sim } of matrix) {
      if (assignedDb.has(dbIdx) || assignedUser.has(userIdx)) continue;

      bijection.set(dbIdx, userIdx);
      assignedDb.add(dbIdx);
      assignedUser.add(userIdx);

      if (warnThreshold !== undefined && sim < warnThreshold) {
        console.warn(
          `⚠️ [${tag}] Low similarity (${sim.toFixed(3)}): ` +
            `"${dbLabels[dbIdx]}" -> "${userLabels[userIdx]}"`,
        );
      } else {
        console.log(
          `[${tag} Bijection] "${dbLabels[dbIdx]}" -> "${userLabels[userIdx]}" (${sim.toFixed(3)})`,
        );
      }

      if (bijection.size === Math.min(dbVecs.length, userVecs.length)) break;
    }

    return bijection;
  }

  // --- Main Solve ---

  public async solve(req: SolveRequest): Promise<SolveResult> {
    if (!this.isReady) await this.init();
    if (!this.orama) throw new Error("Database not initialized");

    const isMatching = Array.isArray(req.terms) && req.terms.length > 0;
    const minPairSimilarity =
      req.overrides.minAnswerSimilarity ?? DEFAULT_MIN_PAIR_SIMILARITY;
    const retrievalLimit =
      req.overrides.candidateCount ?? DEFAULT_RETRIEVAL_LIMIT;
    const minSimilarity =
      req.overrides.minQuestionSimilarity ?? DEFAULT_MIN_QUESTION_SIMILARITY;

    const solveKey = buildCacheKey([
      req.question,
      req.options,
      req.terms,
      req.definitions,
      String(minSimilarity),
      String(minPairSimilarity),
    ]);

    if (!req.overrides.bypassCache) {
      const cached = solveResultCache.get(solveKey);
      if (cached) {
        return { ...(cached as SolveResult), source: "cache" };
      }
    }

    const queryQuestion = req.question.trim();
    const queryOptions = req.options;
    const queryTerms = req.terms;
    const queryDefinitions = req.definitions;

    const queryText = buildQueryText(
      queryQuestion,
      queryOptions,
      queryTerms,
      queryDefinitions,
    );

    const [queryVector, questionOnlyVector] = await Promise.all([
      this.getEmbedding(queryText),
      this.getEmbedding(queryQuestion),
    ]);

    const searchResult = await search(this.orama, {
      mode: "vector",
      vector: { value: queryVector, property: "embedding" },
      similarity: minSimilarity,
      limit: retrievalLimit,
    });

    // ─── Path A: No DB hit at all → pure LLM ────────────────────────────────

    if (!searchResult.count || !searchResult.hits.length) {
      console.log("[Solver] No DB match → LLM fallback");
      return this.solvePurelyWithLLM(req, isMatching, solveKey);
    }

    const { hit, combinedScore } = await this.reRankHits(
      searchResult.hits as unknown as Array<{
        score: number;
        document: { data: string; [k: string]: unknown };
      }>,
      questionOnlyVector,
    );

    const dbQuestion: Question = JSON.parse(String(hit.document.data));

    console.log(
      `📊 Best match: "${dbQuestion.question.slice(0, 80)}..." ` +
        `(vector: ${hit.score.toFixed(3)}, combined: ${combinedScore.toFixed(3)})`,
    );

    // ─── Path B: Low confidence → pure LLM with DB hint ─────────────────────
    // Only pass the DB hit as a hint when its type matches the request type.
    // A mismatched hit (e.g. single-choice "flow table" retrieved for a matching
    // question about routing fields) has zero useful signal and misleads the LLM.

    if (combinedScore < LLM_ONLY_THRESHOLD) {
      console.log(
        `[Solver] Combined score ${combinedScore.toFixed(3)} < ${LLM_ONLY_THRESHOLD} → LLM with hint`,
      );
      // A misclassified question (single-choice with recoverable pairs) counts
      // as a type match for a matching request.
      const hasRecoverablePairs =
        isMatching &&
        dbQuestion.type !== "matching" &&
        dbQuestion.matchingPairs.length === 0 &&
        recoverPairsFromMisclassified(dbQuestion).length > 0;
      const typeMatches = isMatching
        ? dbQuestion.type === "matching" || hasRecoverablePairs
        : dbQuestion.type !== "matching";
      return this.solvePurelyWithLLM(
        req,
        isMatching,
        solveKey,
        typeMatches ? dbQuestion : undefined,
      );
    }

    // ─── Path C: Medium confidence → DB answer + LLM cross-check ────────────

    const needsLLMCrossCheck = combinedScore < LLM_CONSULT_THRESHOLD;

    // ─── Matching questions ──────────────────────────────────────────────────

    // Recover pairs from misclassified DB questions (scraped as single-choice
    // but actually a matching question — pairs encoded in options/explanation).
    let effectivePairs = dbQuestion.matchingPairs;
    if (
      isMatching &&
      effectivePairs.length === 0 &&
      dbQuestion.type !== "matching"
    ) {
      const recovered = recoverPairsFromMisclassified(dbQuestion);
      if (recovered.length > 0) {
        effectivePairs = recovered;
        console.log(
          `[Solver] Using ${recovered.length} recovered pairs from misclassified DB question`,
        );
      }
    }

    if (
      isMatching &&
      (dbQuestion.type === "matching" || effectivePairs.length > 0)
    ) {
      let mappedPairs: Array<{ term: string; definition: string }> = [];

      if (req.terms && req.definitions && effectivePairs.length > 0) {
        mappedPairs = await this.mapMatchingPairs(
          effectivePairs,
          req.terms,
          req.definitions,
          minPairSimilarity,
        );
      }

      // Fallback: definition-only mapping re-associated by index
      if (
        mappedPairs.length === 0 &&
        req.definitions &&
        req.terms &&
        effectivePairs.length > 0
      ) {
        const dbDefinitions = effectivePairs.map((p) => p.definition);
        const mappedDefs = await this.mapAnswersToUserLanguage(
          dbDefinitions,
          [], // no parallel option list for definitions — uses direct similarity
          req.definitions,
          req.question,
          minPairSimilarity,
        );
        mappedPairs = mappedDefs.map((definition, i) => ({
          term: req.terms![i] ?? "",
          definition,
        }));
      }

      // Last-resort: ask LLM directly
      if (mappedPairs.length === 0 || needsLLMCrossCheck) {
        console.log("[Solver] Matching: consulting LLM for pair mapping");
        const dbHint = effectivePairs
          .map((p) => `${p.term} → ${p.definition}`)
          .join("; ");
        const llmPairs = await llmSolveMatching(
          req.question,
          req.terms ?? [],
          req.definitions ?? [],
          effectivePairs.length > 0 ? dbHint : undefined,
        );

        // If LLM returned something, prefer it on low confidence; merge on medium
        if (llmPairs.length > 0) {
          mappedPairs =
            needsLLMCrossCheck && mappedPairs.length > 0
              ? mappedPairs // DB mapping was decent; LLM was just a check
              : llmPairs;
        }
      }

      if (mappedPairs.length === 0) {
        console.warn(
          "⚠️ Pair mapping yielded no results — falling back to raw DB pairs.",
        );
        mappedPairs = effectivePairs;
      }

      const result: SolveResult = {
        matchingPairs: mappedPairs,
        confidence: combinedScore,
        source: needsLLMCrossCheck ? "db+llm" : "db",
        explanation: dbQuestion.explanation,
      };
      solveResultCache.set(solveKey, result);
      return result;
    }

    // ─── Single/multiple-choice ──────────────────────────────────────────────

    let finalAnswers: string[] = [];
    let source: SolveResult["source"] = "db";

    if (
      (dbQuestion.type === "single-choice" ||
        dbQuestion.type === "multiple-choice") &&
      req.options
    ) {
      finalAnswers = await this.mapAnswersToUserLanguage(
        dbQuestion.correctAnswer,
        dbQuestion.options,
        req.options,
        req.question,
        minPairSimilarity,
      );
    }

    // Cross-check with LLM if confidence is medium or mapping failed
    if (needsLLMCrossCheck || finalAnswers.length === 0) {
      console.log(
        `[Solver] ${finalAnswers.length === 0 ? "Mapping failed" : "Low confidence"} → LLM cross-check`,
      );
      const hint = dbQuestion.correctAnswer.join(" / ");
      const { index, reason } = await llmPickOption(
        req.question,
        req.options ?? [],
        hint,
      );

      const llmAnswer = req.options?.[index];
      if (typeof llmAnswer === "string") {
        if (finalAnswers.length === 0) {
          // Mapping totally failed; use LLM answer
          finalAnswers = [llmAnswer];
          source = "llm";
        } else if (!finalAnswers.includes(llmAnswer)) {
          // LLM disagrees with embedding mapping — LLM wins on ambiguous cases
          console.log(
            `[LLM override] Embedding picked "${finalAnswers[0]}", ` +
              `LLM picked "${llmAnswer}" (${reason}). Using LLM.`,
          );
          finalAnswers = [llmAnswer];
          source = "db+llm";
        } else {
          source = "db+llm"; // both agreed
        }
      }
    }

    if (finalAnswers.length === 0) {
      console.warn(
        "⚠️ All answer mapping failed — falling back to raw DB answers.",
      );
      finalAnswers = dbQuestion.correctAnswer;
      source = "db";
    }

    const result: SolveResult = {
      answers: finalAnswers,
      confidence: combinedScore,
      source,
      explanation: dbQuestion.explanation,
    };

    solveResultCache.set(solveKey, result);
    return result;
  }

  /**
   * Solve entirely via LLM when the vector DB provides no useful signal.
   * Accepts an optional weak DB hit as a hint to steer the model.
   */
  private async solvePurelyWithLLM(
    req: SolveRequest,
    isMatching: boolean,
    cacheKey: string,
    dbHint?: Question,
  ): Promise<SolveResult> {
    if (isMatching) {
      const hint = dbHint?.matchingPairs.length
        ? dbHint.matchingPairs
            .map((p) => `${p.term} → ${p.definition}`)
            .join("; ")
        : undefined;

      const pairs = await llmSolveMatching(
        req.question,
        req.terms ?? [],
        req.definitions ?? [],
        hint,
      );

      const result: SolveResult = {
        matchingPairs: pairs,
        confidence: dbHint ? 0.6 : 0.5,
        source: "llm",
        explanation: dbHint?.explanation,
      };
      solveResultCache.set(cacheKey, result);
      return result;
    }

    const hint = dbHint?.correctAnswer.join(" / ");
    const { index, reason } = await llmPickOption(
      req.question,
      req.options ?? [],
      hint,
    );

    const answer = req.options?.[index];
    const result: SolveResult = {
      answers: typeof answer === "string" ? [answer] : [],
      confidence: dbHint ? 0.6 : 0.5,
      source: "llm",
      explanation: reason,
    };
    solveResultCache.set(cacheKey, result);
    return result;
  }
}
