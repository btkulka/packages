export class QueueFullError extends Error {
  constructor(maxDepth: number) {
    super(`Image generation queue full (max depth ${maxDepth}). Try again shortly.`);
    this.name = "QueueFullError";
  }
}

type Job<T> = () => Promise<T>;

/**
 * Depth-bounded job gate in front of ComfyUI.
 *
 * Two independent knobs:
 *  - `maxConcurrent` — how many jobs may RUN at once. Default 1 keeps the old
 *    strictly-serial behaviour (one job on the GPU at a time). Raising it lets
 *    multiple jobs sit on ComfyUI's OWN queue concurrently; ComfyUI still
 *    serializes the GPU, so this is about backlog depth, not parallel rendering.
 *  - `maxDepth` — total running + waiting before `submit()` rejects with
 *    QueueFullError (backpressure so callers don't pile up unboundedly).
 *
 * `maxConcurrent` is mutable at runtime via `setMaxConcurrent()` so a UI can
 * adjust how aggressively we stack onto ComfyUI's queue without a restart;
 * raising it immediately wakes any waiters that now fit under the new ceiling.
 */
export class ImageJobQueue {
  private running = 0;
  private waiting = 0;
  private maxConcurrent: number;

  constructor(
    private readonly maxDepth: number,
    maxConcurrent = 1,
  ) {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  /** Live-adjust how many jobs may run concurrently (>=1). Wakes fitting waiters. */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    // A raised ceiling may admit waiters immediately; wake up to the new slack.
    let slack = this.maxConcurrent - this.running;
    while (slack-- > 0) {
      const next = this.resolvers.shift();
      if (!next) break;
      next();
    }
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  async submit<T>(job: Job<T>): Promise<T> {
    if (this.running + this.waiting >= this.maxDepth) {
      throw new QueueFullError(this.maxDepth);
    }
    this.waiting += 1;
    while (this.running >= this.maxConcurrent) {
      await this.waitForSlot();
    }
    this.waiting -= 1;
    this.running += 1;
    try {
      return await job();
    } finally {
      this.running -= 1;
      // Wake EVERY waiter that now fits under the ceiling, not just one. At the
      // default maxConcurrent=1 this is exactly one wake (unchanged behaviour),
      // but at >=2 a job that THREW could otherwise leave free slots with
      // sleeping waiters — starving the queue. Drain to the available slack,
      // mirroring setMaxConcurrent().
      let slack = this.maxConcurrent - this.running;
      while (slack-- > 0) {
        const next = this.resolvers.shift();
        if (!next) break;
        next();
      }
    }
  }

  private resolvers: Array<() => void> = [];
  private waitForSlot(): Promise<void> {
    return new Promise((res) => this.resolvers.push(res));
  }
}
