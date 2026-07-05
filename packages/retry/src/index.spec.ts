import { describe, expect, it, vi } from 'vitest';

import type { FailedAttemptContext } from './index';

import { retry } from './index';

/** Fast, deterministic defaults: no jitter and constant 1ms delays keep tests quick. */
const FAST = { factor: 1, jitter: false, minTimeout: 1 } as const;

/** A promise plus its resolve/reject handles, for controlling timing in tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('retry', () => {
  it('returns the result without retrying when the first call succeeds', async () => {
    const input = vi.fn(async () => 'ok');

    await expect(retry(input, FAST)).resolves.toBe('ok');
    expect(input).toHaveBeenCalledTimes(1);
  });

  it('retries until a call succeeds, then returns its value', async () => {
    const input = vi.fn(async (attempt: number) => {
      if (attempt < 3) {
        throw new Error(`fail ${attempt}`);
      }
      return 'recovered';
    });

    await expect(retry(input, FAST)).resolves.toBe('recovered');
    expect(input).toHaveBeenCalledTimes(3);
  });

  it('gives up after `retries` extra attempts and throws the last error', async () => {
    let seen = 0;
    const input = vi.fn(async () => {
      seen += 1;
      throw new Error(`fail ${seen}`);
    });

    // retries: 2 → 1 initial call + 2 retries = 3 attempts.
    await expect(retry(input, { ...FAST, retries: 2 })).rejects.toThrow('fail 3');
    expect(input).toHaveBeenCalledTimes(3);
  });

  it('defaults to 10 retries (11 total attempts)', async () => {
    const input = vi.fn(async () => {
      throw new Error('always');
    });

    await expect(retry(input, FAST)).rejects.toThrow('always');
    expect(input).toHaveBeenCalledTimes(11);
  });

  it('does not retry when `retries` is 0', async () => {
    const input = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(retry(input, { ...FAST, retries: 0 })).rejects.toThrow('boom');
    expect(input).toHaveBeenCalledTimes(1);
  });

  it('passes the 1-based attempt number to the input function', async () => {
    const attempts: number[] = [];
    const input = vi.fn((attempt: number) => {
      attempts.push(attempt);
      if (attempt < 3) {
        throw new Error('retry me');
      }
      return 'done';
    });

    await retry(input, FAST);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('rethrows non-Error throws as-is without retrying', async () => {
    const input = vi.fn(() => {
      throw 'a plain string';
    });

    await expect(retry(input, FAST)).rejects.toBe('a plain string');
    expect(input).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-network TypeError (treated as a bug)', async () => {
    const input = vi.fn(() => {
      throw new TypeError('cannot read property of undefined');
    });

    await expect(retry(input, FAST)).rejects.toBeInstanceOf(TypeError);
    expect(input).toHaveBeenCalledTimes(1);
  });

  it('retries a network TypeError (e.g. a failed fetch)', async () => {
    const input = vi.fn(async (attempt: number) => {
      if (attempt === 1) {
        throw new TypeError('Failed to fetch');
      }
      return 'fetched';
    });

    await expect(retry(input, FAST)).resolves.toBe('fetched');
    expect(input).toHaveBeenCalledTimes(2);
  });

  describe('shouldRetry', () => {
    it('stops retrying when it returns false', async () => {
      const input = vi.fn(async () => {
        throw new Error('nope');
      });

      await expect(retry(input, { ...FAST, shouldRetry: () => false })).rejects.toThrow('nope');
      expect(input).toHaveBeenCalledTimes(1);
    });

    it('supports an async predicate', async () => {
      const shouldRetry = vi.fn(async (context: FailedAttemptContext) => context.attemptNumber < 2);
      const input = vi.fn(async () => {
        throw new Error('async gate');
      });

      await expect(retry(input, { ...FAST, shouldRetry })).rejects.toThrow('async gate');
      // attempt 1 → allowed (retry), attempt 2 → denied (stop).
      expect(input).toHaveBeenCalledTimes(2);
    });

    it('receives a frozen context describing the failed attempt', async () => {
      const contexts: FailedAttemptContext[] = [];
      const error = new Error('with context');
      const input = vi.fn(async () => {
        throw error;
      });

      await retry(input, {
        ...FAST,
        retries: 2,
        shouldRetry: (context) => {
          contexts.push(context);
          return true;
        },
      }).catch(() => {});

      // shouldRetry runs on each attempt that still has retries left (attempts 1 and 2).
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toMatchObject({ attemptNumber: 1, error, retriesLeft: 2 });
      expect(contexts[0].retryDelay).toBeGreaterThan(0);
      expect(contexts[1]).toMatchObject({ attemptNumber: 2, error, retriesLeft: 1 });
      expect(Object.isFrozen(contexts[0])).toBe(true);
    });
  });

  describe('abort', () => {
    it('rejects immediately when the signal is already aborted', async () => {
      const input = vi.fn(async () => 'unused');
      const signal = AbortSignal.abort(new Error('already gone'));

      await expect(retry(input, { ...FAST, signal })).rejects.toThrow('already gone');
      expect(input).not.toHaveBeenCalled();
    });

    it('stops immediately when the input throws an AbortError', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      const input = vi.fn(async () => {
        throw abortError;
      });

      await expect(retry(input, FAST)).rejects.toBe(abortError);
      expect(input).toHaveBeenCalledTimes(1);
    });

    it('aborts between attempts and rejects with the abort reason', async () => {
      const ac = new AbortController();
      const reason = new Error('caller gave up');
      const input = vi.fn(async (attempt: number) => {
        if (attempt === 1) {
          ac.abort(reason);
        }
        throw new Error(`fail ${attempt}`);
      });

      await expect(retry(input, { ...FAST, signal: ac.signal })).rejects.toBe(reason);
      // The abort is observed after the first failure, before a second attempt runs.
      expect(input).toHaveBeenCalledTimes(1);
    });

    it('aborts while waiting out the retry delay', async () => {
      const ac = new AbortController();
      const d = deferred<never>();
      const input = vi.fn(async (attempt: number) => {
        if (attempt === 1) {
          // Schedule the abort to land during the (longer) backoff delay.
          queueMicrotask(() => ac.abort(new Error('during delay')));
          throw new Error('first failure');
        }
        return d.promise;
      });

      await expect(
        retry(input, { factor: 2, jitter: false, minTimeout: 50, signal: ac.signal }),
      ).rejects.toThrow('during delay');
      expect(input).toHaveBeenCalledTimes(1);
    });
  });

  describe('maxRetryTime', () => {
    it('gives up once the retry-time budget is exhausted', async () => {
      const input = vi.fn(async () => {
        throw new Error('too slow');
      });

      // A zero budget leaves no time for any retry after the first failure.
      await expect(retry(input, { ...FAST, maxRetryTime: 0 })).rejects.toThrow('too slow');
      expect(input).toHaveBeenCalledTimes(1);
    });
  });

  describe('backoff delay', () => {
    it('grows the delay exponentially by `factor` (no jitter)', async () => {
      vi.useFakeTimers();
      try {
        const delays: number[] = [];
        const original = globalThis.setTimeout;
        const spy = vi
          .spyOn(globalThis, 'setTimeout')
          .mockImplementation((handler, timeout, ...rest) => {
            delays.push(timeout as number);
            return original(handler, timeout, ...rest);
          });

        const input = vi.fn(async () => {
          throw new Error('fail');
        });

        const promise = retry(input, {
          factor: 2,
          jitter: false,
          minTimeout: 100,
          retries: 3,
        });
        // Attach the rejection handler before draining timers so the failure never leaks.
        const assertion = expect(promise).rejects.toThrow('fail');
        await vi.runAllTimersAsync();
        await assertion;

        // attempt 1 → 100, attempt 2 → 200, attempt 3 → 400.
        expect(delays).toEqual([100, 200, 400]);
        spy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
