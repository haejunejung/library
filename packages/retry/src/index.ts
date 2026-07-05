import isNetworkError from 'is-network-error';

export type FailedAttemptContext = {
  /** 1-based attempt count (1 = first call). */
  readonly attemptNumber: number;
  readonly error: Error;
  /** Retries left after this attempt. `Infinity` when `retries` is `Infinity`. */
  readonly retriesLeft: number;
  /** Delay (ms) before the next retry, or 0 if no retry will happen. */
  readonly retryDelay: number;
};

export type Options = {
  /** Exponential backoff factor. Default: `2`. */
  factor?: number;
  /** Add random jitter to delays (1x–2x). Default: `true`. */
  jitter?: boolean;
  /** Max total time to keep retrying (ms). Default: `Infinity`. */
  maxRetryTime?: number;
  /** Max delay between retries (ms). Default: `Infinity`. */
  maxTimeout?: number;
  /** Delay before the first retry (ms). Default: `1000`. */
  minTimeout?: number;
  /** Max retries (not counting the first call). Default: `10`. Use `Infinity` for endless retries. */
  retries?: number;
  /** Decide whether to retry a given error. Default: always retry. */
  shouldRetry?: (context: FailedAttemptContext) => boolean | Promise<boolean>;
  /** Abort the whole operation. */
  signal?: AbortSignal;
};

export async function retry<T>(
  input: (attemptNumber: number) => PromiseLike<T> | T,
  options: Options = {},
): Promise<T> {
  const {
    factor = 2,
    jitter = true,
    maxRetryTime = Number.POSITIVE_INFINITY,
    maxTimeout = Number.POSITIVE_INFINITY,
    minTimeout = 1000,
    retries = 10,
    shouldRetry = () => true,
    signal,
  } = options;

  signal?.throwIfAborted();

  const startTime = performance.now();
  const getRemainingTime = () =>
    Number.isFinite(maxRetryTime)
      ? maxRetryTime - (performance.now() - startTime)
      : Number.POSITIVE_INFINITY;

  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      signal?.throwIfAborted();
      const result = await input(attemptNumber);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      // Only Errors are retryable; rethrow anything else (thrown strings, etc.) as-is.
      if (!(error instanceof Error)) {
        throw error;
      }

      // Stop immediately on abort — either the signal fired or the user threw an AbortError.
      if (error.name === 'AbortError') {
        throw error;
      }

      const retriesLeft = Number.isFinite(retries)
        ? retries - (attemptNumber - 1)
        : Number.POSITIVE_INFINITY;
      const retryDelay = calculateDelayMs(attemptNumber, {
        factor,
        jitter,
        maxTimeout,
        minTimeout,
      });

      const context: FailedAttemptContext = Object.freeze({
        attemptNumber,
        error,
        retriesLeft,
        retryDelay: retriesLeft > 0 ? retryDelay : 0,
      });

      // Give up if out of retries, out of time, the error is a non-network bug, or the user opted out.
      if (
        retriesLeft <= 0 ||
        getRemainingTime() <= 0 ||
        (error instanceof TypeError && !isNetworkError(error)) ||
        !(await shouldRetry(context))
      ) {
        throw error;
      }

      signal?.throwIfAborted();
      await delayForRetry(Math.min(retryDelay, getRemainingTime()), signal);
      signal?.throwIfAborted();
    }
  }
}

function calculateDelayMs(
  attemptNumber: number,
  {
    factor,
    jitter,
    maxTimeout,
    minTimeout,
  }: Required<Pick<Options, 'factor' | 'jitter' | 'maxTimeout' | 'minTimeout'>>,
): number {
  const random = jitter ? Math.random() + 1 : 1;
  const timeout = Math.round(random * minTimeout * factor ** (attemptNumber - 1));
  return Math.min(timeout, maxTimeout);
}

async function delayForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  if (delay <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(token);
      reject(signal!.reason);
    };

    const token = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
