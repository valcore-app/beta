/**
 * API Client with retry logic, error handling, and fallback support
 */

export type RetryConfig = {
  maxRetries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  maxDelayMs?: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public endpoint?: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Fetch with timeout support
 */
const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
};

/**
 * Retry wrapper with exponential backoff
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> => {
  const { maxRetries = 3, backoffMs = 1000, maxDelayMs = 30000 } = config;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        const baseDelay = backoffMs * Math.pow(2, attempt);
        let delay = baseDelay;
        if (lastError instanceof ApiError && lastError.statusCode === 429) {
          // Respect provider cooldown hint when available.
          delay = Math.max(baseDelay, lastError.retryAfterMs ?? 15000);
        }
        delay = Math.min(delay, maxDelayMs);
        // Retry without noisy logging
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
};

/**
 * Fetch JSON with retry and timeout
 */
export const fetchJsonWithRetry = async <T>(
  url: string,
  headers?: Record<string, string>,
  config: RetryConfig = {},
): Promise<T> => {
  const { timeoutMs = 10000 } = config;

  return retryWithBackoff(async () => {
    const response = await fetchWithTimeout(
      url,
      { headers: headers || {} },
      timeoutMs,
    );

    if (!response.ok) {
      const retryAfterRaw = response.headers.get("retry-after");
      const retryAfterMs = retryAfterRaw
        ? Number.isFinite(Number(retryAfterRaw))
          ? Math.max(0, Number(retryAfterRaw)) * 1000
          : undefined
        : undefined;
      throw new ApiError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        url,
        retryAfterMs,
      );
    }

    return (await response.json()) as T;
  }, config);
};

/**
 * Sleep utility
 */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chunk array into smaller arrays
 */
export const chunk = <T>(array: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

/**
 * Run tasks with concurrency limit
 */
export const withConcurrency = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      results[currentIndex] = await task(item);
    }
  });

  await Promise.all(workers);
  return results;
};

