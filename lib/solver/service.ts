import fs from "node:fs";
import { pipeline } from "@huggingface/transformers";
import { type AnyOrama, create, search } from "@orama/orama";
import { restoreFromFile } from "@orama/plugin-data-persistence/server";

import { buildCacheKey, embeddingCache, solveResultCache } from "../cache";
import type { Question } from "../types";
import {
  ANSWER_AMBIGUITY_MARGIN,
  DEFAULT_MIN_PAIR_SIMILARITY,
  DEFAULT_MIN_QUESTION_SIMILARITY,
  DEFAULT_RETRIEVAL_LIMIT,
  EMBEDDING_MODEL,
  INDEX_PATH,
  LLM_CONSULT_THRESHOLD,
  LLM_ONLY_THRESHOLD,
  RERANK_QUESTION_WEIGHT,
} from "./constants";
import { llmPickMultiple, llmPickOption, llmSolveMatching } from "./llm";
import type { SolveRequest, SolveResult } from "./types";
import { buildQueryText, cleanOptionText, cos_sim } from "./utils";

type OramaHit = {
  score: number;
  document: { data: string; [k: string]: unknown };
};

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
      local_files_only: true, // OFFLINE ONLY
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
      if (cached) return { ...(cached as SolveResult), source: "cache" };
    }

    const queryText = buildQueryText(
      req.question.trim(),
      req.options,
      req.terms,
      req.definitions,
    );

    const [queryVector, questionOnlyVector] = await Promise.all([
      this.getEmbedding(queryText),
      this.getEmbedding(req.question.trim()),
    ]);

    const searchResult = await search(this.orama, {
      mode: "vector",
      vector: { value: queryVector, property: "embedding" },
      similarity: minSimilarity,
      limit: retrievalLimit,
    });

    if (!searchResult.count || !searchResult.hits.length) {
      console.log("[Solver] No DB match -> LLM fallback");
      return this.solvePurelyWithLLM(req, isMatching, solveKey);
    }

    const { hit, combinedScore } = await this.reRankHits(
      searchResult.hits as unknown as OramaHit[],
      questionOnlyVector,
    );

    const dbQuestion: Question = JSON.parse(String(hit.document.data));

    console.log(
      `Best match: "${dbQuestion.question.slice(0, 80)}..." ` +
        `(vector: ${hit.score.toFixed(3)}, combined: ${combinedScore.toFixed(3)})`,
    );

    if (combinedScore < LLM_ONLY_THRESHOLD) {
      console.log(
        `[Solver] Combined score ${combinedScore.toFixed(3)} < ${LLM_ONLY_THRESHOLD} -> LLM with hint`,
      );
      const dbHint = this.selectHintIfTypeMatches(dbQuestion, isMatching);
      return this.solvePurelyWithLLM(req, isMatching, solveKey, dbHint);
    }

    const needsLLMCrossCheck = combinedScore < LLM_CONSULT_THRESHOLD;

    if (isMatching) {
      return this.solveMatching(
        req,
        dbQuestion,
        solveKey,
        combinedScore,
        needsLLMCrossCheck,
        minPairSimilarity,
      );
    }

    return this.solveChoice(
      req,
      dbQuestion,
      solveKey,
      combinedScore,
      needsLLMCrossCheck,
      minPairSimilarity,
    );
  }

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

  private async reRankHits(
    hits: OramaHit[],
    questionVec: number[],
  ): Promise<{ hit: OramaHit; combinedScore: number }> {
    const dbQuestions = hits.map((h) => {
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

  private async solvePurelyWithLLM(
    req: SolveRequest,
    isMatching: boolean,
    cacheKey: string,
    dbHint?: Question,
  ): Promise<SolveResult> {
    let result: SolveResult;

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

      result = {
        matchingPairs: pairs,
        confidence: dbHint ? 0.6 : 0.5,
        source: "llm",
        explanation: dbHint?.explanation,
      };
    } else {
      const hint = dbHint?.correctAnswer.join(" / ");
      const isMultiple = dbHint?.type === "multiple-choice";

      if (isMultiple) {
        const count = dbHint!.correctAnswer.length;
        const { indices, reason } = await llmPickMultiple(
          req.question,
          req.options ?? [],
          count,
          hint,
        );
        const answers = indices
          .map((i) => req.options?.[i])
          .filter((a): a is string => typeof a === "string");
        result = {
          answers,
          confidence: dbHint ? 0.6 : 0.5,
          source: "llm",
          explanation: reason,
        };
      } else {
        const { index, reason } = await llmPickOption(
          req.question,
          req.options ?? [],
          hint,
        );
        const answer = req.options?.[index];
        result = {
          answers: typeof answer === "string" ? [answer] : [],
          confidence: dbHint ? 0.6 : 0.5,
          source: "llm",
          explanation: reason,
        };
      }
    }

    solveResultCache.set(cacheKey, result);
    return result;
  }

  private async solveMatching(
    req: SolveRequest,
    dbQuestion: Question,
    solveKey: string,
    combinedScore: number,
    needsLLMCrossCheck: boolean,
    minPairSimilarity: number,
  ): Promise<SolveResult> {
    const effectivePairs = dbQuestion.matchingPairs;

    let mappedPairs: Array<{ term: string; definition: string }> = [];

    if (req.terms && req.definitions && effectivePairs.length > 0) {
      mappedPairs = await this.mapMatchingPairs(
        effectivePairs,
        req.terms,
        req.definitions,
        minPairSimilarity,
      );
    }

    if (
      mappedPairs.length === 0 &&
      req.definitions &&
      req.terms &&
      effectivePairs.length > 0
    ) {
      const dbDefinitions = effectivePairs.map((p) => p.definition);
      const mappedDefs = await this.mapAnswersToUserLanguage(
        dbDefinitions,
        [],
        req.definitions,
        req.question,
        minPairSimilarity,
      );
      mappedPairs = mappedDefs.map((definition, i) => ({
        term: req.terms![i] ?? "",
        definition,
      }));
    }

    if (mappedPairs.length === 0 || needsLLMCrossCheck) {
      console.log("[Solver] Matching: consulting LLM for pair mapping");
      const dbHint = effectivePairs
        .map((p) => `${p.term} -> ${p.definition}`)
        .join("; ");
      const llmPairs = await llmSolveMatching(
        req.question,
        req.terms ?? [],
        req.definitions ?? [],
        effectivePairs.length > 0 ? dbHint : undefined,
      );

      if (llmPairs.length > 0) {
        mappedPairs =
          needsLLMCrossCheck && mappedPairs.length > 0 ? mappedPairs : llmPairs;
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

  private async solveChoice(
    req: SolveRequest,
    dbQuestion: Question,
    solveKey: string,
    combinedScore: number,
    needsLLMCrossCheck: boolean,
    minPairSimilarity: number,
  ): Promise<SolveResult> {
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

    if (needsLLMCrossCheck || finalAnswers.length === 0) {
      console.log(
        `[Solver] ${finalAnswers.length === 0 ? "Mapping failed" : "Low confidence"} → LLM cross-check`,
      );
      const hint = dbQuestion.correctAnswer.join(" / ");
      const isMultiple = dbQuestion.type === "multiple-choice";

      if (isMultiple) {
        const count = dbQuestion.correctAnswer.length;
        const { indices, reason } = await llmPickMultiple(
          req.question,
          req.options ?? [],
          count,
          hint,
        );
        const llmAnswers = indices
          .map((i) => req.options?.[i])
          .filter((a): a is string => typeof a === "string");

        if (llmAnswers.length > 0) {
          const llmMatchesDb = llmAnswers.every((a) =>
            finalAnswers.includes(a),
          );
          if (finalAnswers.length === 0) {
            finalAnswers = llmAnswers;
            source = "llm";
          } else if (!llmMatchesDb) {
            console.log(
              `[LLM override] Embedding picked [${finalAnswers.join(", ")}], ` +
                `LLM picked [${llmAnswers.join(", ")}] (${reason}). Using LLM.`,
            );
            finalAnswers = llmAnswers;
            source = "db+llm";
          } else {
            source = "db+llm";
          }
        }
      } else {
        const { index, reason } = await llmPickOption(
          req.question,
          req.options ?? [],
          hint,
        );
        const llmAnswer = req.options?.[index];
        if (typeof llmAnswer === "string") {
          if (finalAnswers.length === 0) {
            finalAnswers = [llmAnswer];
            source = "llm";
          } else if (!finalAnswers.includes(llmAnswer)) {
            console.log(
              `[LLM override] Embedding picked "${finalAnswers[0]}", ` +
                `LLM picked "${llmAnswer}" (${reason}). Using LLM.`,
            );
            finalAnswers = [llmAnswer];
            source = "db+llm";
          } else {
            source = "db+llm";
          }
        }
      }
    }

    if (finalAnswers.length === 0) {
      console.warn(
        "All answer mapping failed, falling back to raw DB answers.",
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

  private async mapAnswersToUserLanguage(
    dbAnswers: string[],
    dbAllOptions: string[],
    userOptions: string[],
    originalQuestion: string,
    minPairSimilarity = DEFAULT_MIN_PAIR_SIMILARITY,
  ): Promise<string[]> {
    if (dbAnswers.length === 0 || userOptions.length === 0) return [];

    if (dbAllOptions.length > 0 && dbAllOptions.length === userOptions.length) {
      const bijection = await this.buildOptionBijection(
        dbAllOptions,
        userOptions,
      );
      const mappedAnswers: string[] = [];

      for (const dbAnswer of dbAnswers) {
        const cleanAnswer = cleanOptionText(dbAnswer);
        const dbOptionIndex = dbAllOptions.findIndex(
          (opt) => cleanOptionText(opt) === cleanAnswer,
        );

        if (dbOptionIndex !== -1) {
          const userIdx = bijection.get(dbOptionIndex);
          const chosen =
            userIdx !== undefined ? userOptions[userIdx] : undefined;
          if (typeof chosen === "string") {
            console.log(
              `[AnswerMap] "${dbAnswer}" -> "${chosen}" (via bijection index ${dbOptionIndex}->${userIdx})`,
            );
            mappedAnswers.push(chosen);
            continue;
          }
        }

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

  private async buildOptionBijection(
    dbOptions: string[],
    userOptions: string[],
  ): Promise<Map<number, number>> {
    const bijection = new Map<number, number>();
    const usedUser = new Set<number>();

    for (let d = 0; d < dbOptions.length; d++) {
      const normalised = dbOptions[d]!.toLowerCase().trim();
      const u = userOptions.findIndex(
        (opt, i) => !usedUser.has(i) && opt.toLowerCase().trim() === normalised,
      );
      if (u !== -1) {
        bijection.set(d, u);
        usedUser.add(u);
      }
    }

    const remainingDb = dbOptions
      .map((_, i) => i)
      .filter((i) => !bijection.has(i));
    const remainingUser = userOptions
      .map((_, i) => i)
      .filter((i) => !usedUser.has(i));

    if (remainingDb.length === 0) return bijection;

    const [dbVecs, userVecs] = await Promise.all([
      this.getEmbedding(remainingDb.map((i) => cleanOptionText(dbOptions[i]!))),
      this.getEmbedding(
        remainingUser.map((i) => cleanOptionText(userOptions[i]!)),
      ),
    ]);

    const semanticBijection = this.greedyBijectiveMatch(
      dbVecs as number[][],
      userVecs as number[][],
      remainingDb.map((i) => dbOptions[i]!),
      remainingUser.map((i) => userOptions[i]!),
      "Option",
    );

    for (const [relDb, relUser] of semanticBijection) {
      bijection.set(remainingDb[relDb]!, remainingUser[relUser]!);
    }

    return bijection;
  }

  private async mapSingleAnswerDirect(
    dbAnswer: string,
    userOptions: string[],
    originalQuestion: string,
    minPairSimilarity: number,
  ): Promise<string | null> {
    const [dbVec, userVecs] = await Promise.all([
      this.getEmbedding(cleanOptionText(dbAnswer)),
      this.getEmbedding(userOptions.map(cleanOptionText)),
    ]);

    const scores = (userVecs as number[][])
      .map((uv, j) => ({ idx: j, sim: cos_sim(dbVec, uv) }))
      .sort((a, b) => b.sim - a.sim);

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
        `⚠️ Low pair similarity (${best.sim.toFixed(3)}) for "${dbAnswer}" -> "${userOptions[best.idx]}"`,
      );
    }

    return userOptions[best.idx] ?? null;
  }

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

    const [dbTermVecs, dbDefVecs, userTermVecs, userDefVecs] =
      await Promise.all([
        this.getEmbedding(dbPairs.map((p) => cleanOptionText(p.term))),
        this.getEmbedding(dbPairs.map((p) => cleanOptionText(p.definition))),
        this.getEmbedding(userTerms.map(cleanOptionText)),
        this.getEmbedding(userDefinitions.map(cleanOptionText)),
      ]);

    interface Cell {
      termIdx: number;
      defIdx: number;
      score: number;
      dbIdx: number;
      swapped: boolean;
    }

    const n = userTerms.length;
    const m = userDefinitions.length;
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
      const orient = swapped ? "swapped" : "normal";
      const dbPair = dbPairs[dbIdx]!;

      if (avgSim < minPairSimilarity) {
        console.warn(
          `[Matching] Low similarity (avg ${avgSim.toFixed(3)}, ${orient}): ` +
            `"${userTerm}" <-> "${userDef}" (best DB pair: "${dbPair.term}" | "${dbPair.definition}")`,
        );
      } else {
        console.log(
          `[Matching] "${userTerm}" <-> "${userDef}" ` +
            `(avg sim ${avgSim.toFixed(3)}, ${orient}, DB: "${dbPair.term}" | "${dbPair.definition}")`,
        );
      }

      result.push({ term: userTerm, definition: userDef });
      if (result.length === Math.min(n, m)) break;
    }

    return result;
  }

  private greedyBijectiveMatch(
    dbVecs: number[][],
    userVecs: number[][],
    dbLabels: string[],
    userLabels: string[],
    tag: string,
    warnThreshold?: number,
  ): Map<number, number> {
    const matrix = dbVecs.flatMap((dv, d) =>
      userVecs.map((uv, u) => ({ dbIdx: d, userIdx: u, sim: cos_sim(dv, uv) })),
    );
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

  private selectHintIfTypeMatches(
    dbQuestion: Question,
    isMatching: boolean,
  ): Question | undefined {
    return isMatching
      ? dbQuestion.type === "matching"
        ? dbQuestion
        : undefined
      : dbQuestion.type !== "matching"
        ? dbQuestion
        : undefined;
  }
}
