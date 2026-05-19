/**
 * Configuration options for the exponential interval scheduler.
 */
export type IntervalOptions = {
  /**
   * The initial delay in milliseconds before the first invocation.
   * Also the value that `resetInterval()` restores `currentInterval` to.
   */
  interval: number;
  /**
   * The multiplier applied to the delay after each invocation.
   * The delay grows as: interval → interval*m → interval*m² → ... → maxInterval.
   */
  multiplier: number;
  /**
   * The upper bound in milliseconds for any computed interval.
   */
  maxInterval: number;
  /**
   * Maximum number of invocation attempts. Defaults to infinite.
   */
  maxAttempts?: number;
  /**
   * If true, performs the first invocation immediately (without initial delay).
   * The second invocation follows after `interval * multiplier` ms.
   * Subsequent invocations continue the exponential backoff schedule.
   */
  immediate?: boolean;
};

/**
 * Handle to control the lifecycle of the exponential timer.
 */
export type ExponentialTimer = {
  /**
   * Stops further scheduled invocations and clears any pending timeout.
   *
   * Note: if `destroy()` is called while `asyncFunction` is in-flight, the
   * current invocation completes normally. No new timeout will be scheduled
   * after it finishes. `destroy()` does not abort an already-running async call.
   */
  destroy: () => void;
};

/**
 * Schedules repeated execution of an asynchronous task using exponential backoff.
 *
 * The timer starts fast and slows down over time:
 *   interval → interval*multiplier → interval*multiplier² → ... → maxInterval
 *
 * @template R The return type of the asyncFunction (unused by scheduler).
 * @param asyncFunction
 *   The function to invoke on each tick. It receives a `resetInterval` callback.
 *
 *   **`resetInterval()` semantics:** calling it resets `currentInterval` back to
 *   `interval` and `attemptCount` to 0. However, because the interval multiplication
 *   (`currentInterval *= multiplier`) happens AFTER `asyncFunction` returns, the
 *   first scheduled tick after a reset fires at `interval * multiplier`, not `interval`.
 *   This is expected — reset brings the timer back to the beginning of the exponential
 *   curve, not to zero. Example: interval=2000, multiplier=1.6 → after reset(), next
 *   tick fires at 3200ms, then 5120ms, etc.
 *
 *   Errors thrown by `asyncFunction` are silently swallowed — the scheduler continues
 *   regardless. Handle errors inside `asyncFunction` (e.g., logging, failover).
 *
 * @param options
 *   Configuration options:
 *   - `interval`: Initial delay before first invocation (and reset target).
 *   - `multiplier`: Factor to multiply the delay after each call.
 *   - `maxInterval`: Maximum delay between invocations.
 *   - `maxAttempts`: Optional maximum number of calls (infinite by default).
 *   - `immediate`: If true, run first tick immediately; second tick after `interval*multiplier`.
 * @returns A controller object with a `destroy()` method to stop future invocations.
 *
 * @example
 * ```ts
 * const timer = exponentialIntervalAsync(async (reset) => {
 *   try {
 *     await doWork();
 *     // on success: do NOT reset — let interval grow toward maxInterval (monitoring mode)
 *   } catch {
 *     reset(); // on error: reset so next tick is sooner (retry from start of curve)
 *   }
 * }, { interval: 2000, multiplier: 1.6, maxInterval: 30000 });
 *
 * // stop later:
 * setTimeout(() => timer.destroy(), 60000);
 * ```
 */
export const exponentialIntervalAsync = (
  asyncFunction: (resetInterval: () => void) => Promise<void>,
  options: IntervalOptions
): ExponentialTimer => {
  const { interval, multiplier, maxInterval, maxAttempts = Infinity, immediate = false } = options;

  if (maxInterval < interval) {
    throw new Error('maxInterval cannot be less than initial interval');
  }

  let attemptCount = 0;
  let currentInterval = interval;
  let stopped = false;
  // isRunning guard: implements the ADR "skip instead of queuing" contract.
  // In the current sequential architecture (next setTimeout is only scheduled after
  // the current tick completes), this flag cannot be true at scheduler entry.
  // It is kept as an explicit expression of the architectural decision and as a
  // safety net against future changes to the scheduling model.
  let isRunning = false;
  // Universal timeout handle (works both in Node and browser)
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // Reset the backoff sequence to its initial values.
  // Note: if called from inside asyncFunction, the effect on next tick delay is:
  // currentInterval is reset to `interval`, but then immediately multiplied by
  // `multiplier` after fn returns, so the next tick fires at interval*multiplier.
  const resetInterval = () => {
    currentInterval = interval;
    attemptCount = 0;
  };

  // Internal scheduler that invokes the async function and reschedules itself.
  const scheduler = async () => {
    if (stopped) return;
    if (attemptCount >= maxAttempts) return;
    if (isRunning) return; // skip — never queue concurrent ticks

    isRunning = true;
    try {
      await asyncFunction(resetInterval);
    } catch {
      // Async errors do not stop the scheduler; they are intentionally ignored.
    } finally {
      isRunning = false;
    }

    attemptCount++;
    // Advance interval AFTER fn completes (including any reset() call inside fn).
    currentInterval = Math.min(currentInterval * multiplier, maxInterval);

    if (!stopped && attemptCount < maxAttempts) {
      timeoutId = setTimeout(scheduler, currentInterval);
    }
  };

  // Either start immediately or after the initial delay — but never both.
  if (immediate) {
    // fire-and-forget; scheduling of next ticks happens inside `scheduler`
    void scheduler();
  } else {
    timeoutId = setTimeout(scheduler, currentInterval);
  }

  // Return the control object
  return {
    // Stops any further invocations and clears the pending timeout.
    // Does not abort any currently in-flight asyncFunction call.
    destroy: () => {
      stopped = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    },
  };
};
