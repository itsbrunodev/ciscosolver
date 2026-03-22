import { createFactory } from "hono/factory";

import { buildCacheKey, solveResultCache } from "@/lib/cache";
import { solveQueue } from "@/lib/queue";
import { SolverService } from "@/lib/solver";
import { stats } from "@/lib/stats";

const factory = createFactory();

export const solveHandlers = factory.createHandlers(async (c) => {
  stats.requestStarted();

  try {
    const body = await c.req.json();

    if (!body.question || typeof body.question !== "string") {
      return c.json(
        { error: "Field 'question' is required and must be a string" },
        400,
      );
    }
    if (!body.overrides || typeof body.overrides !== "object") {
      return c.json(
        { error: "Field 'overrides' is required and must be an object" },
        400,
      );
    }

    const isMatching = Array.isArray(body.terms) && body.terms.length > 0;
    const isStandard = Array.isArray(body.options);

    if (!isMatching && !isStandard) {
      return c.json(
        {
          error:
            "Request must contain either 'options' or 'terms'/'definitions' array",
        },
        400,
      );
    }

    const cacheKey = buildCacheKey([
      body.question,
      body.options,
      body.terms,
      body.definitions,
    ]);

    if (!body.overrides?.bypassCache) {
      const cached = solveResultCache.get(cacheKey);

      if (cached) {
        stats.cacheHit();
        return c.json(cached);
      }
    }

    const solver = SolverService.getInstance();
    await solver.init();

    const result = await solveQueue.run(cacheKey, async () => {
      if (!body.overrides?.bypassCache) {
        const cached = solveResultCache.get(cacheKey);

        if (cached) {
          stats.cacheHit();

          return cached;
        }
      }

      const solved = await solver.solve({
        question: body.question,
        options: body.options,
        terms: body.terms,
        definitions: body.definitions,
        overrides: {
          minQuestionSimilarity: body.overrides.minQuestionSimilarity,
          minAnswerSimilarity: body.overrides.minAnswerSimilarity,
          candidateCount: body.overrides.candidateCount,
          bypassCache: body.overrides.bypassCache,
        },
      });

      solveResultCache.set(cacheKey, solved);

      return solved;
    });

    return c.json(result);
  } catch (error) {
    stats.errorOccurred();

    console.error("Solve Endpoint Error:", error);

    if (error instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON in request body" }, 400);
    }

    return c.json({ error: "Internal Server Error" }, 500);
  } finally {
    stats.requestFinished();
  }
});
