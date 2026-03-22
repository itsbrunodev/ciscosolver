class RequestStats {
  private static _instance: RequestStats;

  private _totalRequests = 0;
  private _activeRequests = 0;
  private _cacheHits = 0;
  private _errors = 0;

  public queuedCount = 0;
  public runningCount = 0;
  public maxConcurrent = 0;

  private constructor() {}

  static getInstance(): RequestStats {
    if (!RequestStats._instance) {
      RequestStats._instance = new RequestStats();
    }
    return RequestStats._instance;
  }

  requestStarted(): void {
    this._totalRequests++;
    this._activeRequests++;
  }

  requestFinished(): void {
    this._activeRequests = Math.max(0, this._activeRequests - 1);
  }

  cacheHit(): void {
    this._cacheHits++;
  }

  errorOccurred(): void {
    this._errors++;
  }

  get snapshot() {
    return {
      totalRequests: this._totalRequests,
      activeRequests: this._activeRequests,
      cacheHits: this._cacheHits,
      errors: this._errors,
      queueStats: {
        queued: this.queuedCount,
        running: this.runningCount,
        maxConcurrent: this.maxConcurrent,
      },
    };
  }
}

export const stats = RequestStats.getInstance();
