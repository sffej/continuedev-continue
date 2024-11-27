const DEFAULT_CACHE_TIME = 2 * 60 * 1000; // 2 minutes

export class SingleValueCache<T> {
  private value: T | null;
  private expiry: number;
  private queryFunction: () => Promise<T>;
  private cacheTimeMs: number;

  constructor(
    queryFunction: () => Promise<T>,
    cacheTimeMs?: number,
    initialValue?: T,
  ) {
    this.queryFunction = queryFunction;
    this.cacheTimeMs = cacheTimeMs ?? DEFAULT_CACHE_TIME;
    this.expiry = Date.now();
    this.value = initialValue ?? null;
  }

  public async get(): Promise<T> {
    const now = Date.now();
    if (this.value && now < this.expiry) {
      return this.value;
    }
    this.value = await this.queryFunction();
    this.expiry = now + this.cacheTimeMs;
    return this.value;
  }

  public invalidate(): void {
    this.value = null;
  }
}
