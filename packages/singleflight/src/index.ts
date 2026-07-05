/**
 * SingleFlight deduplicates concurrent async operations by key.
 *
 * For the same key:
 * - The first caller executes the factory function.
 * - Subsequent callers receive the same in-flight Promise.
 *
 * Once the Promise settles (resolve/reject), the entry is removed,
 * so future calls will execute again.
 *
 * Cancellation is per-caller only: passing an `AbortSignal` lets a caller
 * stop awaiting the shared operation, but it does NOT abort the underlying
 * work. Other callers waiting on the same key are unaffected, and the
 * factory keeps running to completion. This mirrors Go's `singleflight.DoChan`.
 */
export class SingleFlight {
  private inFlight = new Map<string, Promise<unknown>>();

  async doAsync<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw signal.reason ?? abortError();
    }

    const existing = this.inFlight.get(key);

    const shared =
      existing ??
      (() => {
        const promise = fn().finally(() => {
          this.inFlight.delete(key);
        });
        this.inFlight.set(key, promise);
        return promise;
      })();

    if (!signal) return shared as Promise<T>;

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? abortError());
      const cleanup = () => signal.removeEventListener('abort', onAbort);

      shared.then(
        (value) => {
          cleanup();
          resolve(value as T);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}
