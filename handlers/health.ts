// handlers/health.ts
import { createFactory } from "hono/factory";

import { solveResultCache } from "@/lib/cache";
import { stats } from "@/lib/stats";

const factory = createFactory();

const startTime = Date.now();

export const healthHandlers = factory.createHandlers(async (c) => {
  const memUsage = process.memoryUsage();
  const s = stats.snapshot;

  return c.json({
    status: "ok",
    uptime: Date.now() - startTime,
    activeRequests: s.activeRequests,
    totalRequests: s.totalRequests,
    cacheHits: s.cacheHits,
    errors: s.errors,
    queueStats: s.queueStats,
    cacheSize: solveResultCache.size,
    cpuUsage: "??%",
    memory: {
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
    },
  });
});
