import { stats } from "./stats";

const MAX_CONCURRENT = 3;

type Task<T> = () => Promise<T>;

class ConcurrencyQueue {
  private running = 0;
  private readonly max: number;
  private readonly waitQueue: Array<() => void> = [];

  // key -> Promise for in-flight work
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(max: number) {
    this.max = max;
    stats.maxConcurrent = max;
  }

  async run<T>(dedupeKey: string, task: Task<T>): Promise<T> {
    const existing = this.inFlight.get(dedupeKey);

    if (existing) {
      console.log(`[Queue] Dedup hit for key: ${dedupeKey.substring(0, 60)}…`);

      return existing as Promise<T>;
    }

    if (this.running >= this.max) {
      stats.queuedCount++;

      this.syncStats();
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));

      stats.queuedCount = Math.max(0, stats.queuedCount - 1);
    }

    this.running++;
    stats.runningCount = this.running;
    this.syncStats();

    const promise = task().finally(() => {
      this.inFlight.delete(dedupeKey);
      this.running--;
      stats.runningCount = this.running;
      this.syncStats();

      const next = this.waitQueue.shift();
      if (next) next();
    });

    this.inFlight.set(dedupeKey, promise);

    return promise;
  }

  private syncStats() {
    stats.queuedCount = this.waitQueue.length;
    stats.runningCount = this.running;
  }
}

export const solveQueue = new ConcurrencyQueue(MAX_CONCURRENT);
