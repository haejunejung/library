import { describe, expect, it, vi } from 'vitest';

import { SingleFlight } from './index';

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

describe('SingleFlight', () => {
  it('runs the factory once for concurrent callers with the same key', async () => {
    const sf = new SingleFlight();
    const fn = vi.fn(async () => 'value');

    const [a, b] = await Promise.all([sf.doAsync('k', fn), sf.doAsync('k', fn)]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe('value');
    expect(b).toBe('value');
  });

  it('runs the factory again after the entry settles', async () => {
    const sf = new SingleFlight();
    const fn = vi.fn(async () => 'value');

    await sf.doAsync('k', fn);
    await sf.doAsync('k', fn);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  describe('cancellation (per-caller AbortSignal)', () => {
    it('rejects the aborting caller without disturbing others', async () => {
      const sf = new SingleFlight();
      const d = deferred<string>();
      const fn = vi.fn(() => d.promise);

      const ac = new AbortController();
      const aborting = sf.doAsync('k', fn, ac.signal);
      const waiting = sf.doAsync('k', fn); // same in-flight work, no signal

      ac.abort();

      await expect(aborting).rejects.toMatchObject({ name: 'AbortError' });

      // Shared work still completes for the caller that kept waiting.
      d.resolve('done');
      await expect(waiting).resolves.toBe('done');

      // Factory ran exactly once despite the abort.
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("propagates the signal's custom abort reason", async () => {
      const sf = new SingleFlight();
      const d = deferred<string>();

      const ac = new AbortController();
      const call = sf.doAsync('k', () => d.promise, ac.signal);
      const reason = new Error('caller gave up');
      ac.abort(reason);

      await expect(call).rejects.toBe(reason);

      // Keep the shared work handled so it doesn't leak as an unhandled value.
      d.resolve('x');
    });

    it('rejects immediately if the signal is already aborted', async () => {
      const sf = new SingleFlight();
      const fn = vi.fn(async () => 'value');

      await expect(sf.doAsync('k', fn, AbortSignal.abort(new Error('nope')))).rejects.toThrow(
        'nope',
      );

      // A pre-aborted caller never starts the work.
      expect(fn).not.toHaveBeenCalled();
    });

    it('keeps shared work alive when only one of several callers aborts', async () => {
      const sf = new SingleFlight();
      const d = deferred<string>();
      const fn = vi.fn(() => d.promise);

      const ac = new AbortController();
      const first = sf.doAsync('k', fn, ac.signal);
      const second = sf.doAsync('k', fn);
      const third = sf.doAsync('k', fn);

      ac.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });

      d.resolve('shared');
      await expect(Promise.all([second, third])).resolves.toEqual(['shared', 'shared']);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
