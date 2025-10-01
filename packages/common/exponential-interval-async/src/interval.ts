/**
 * Configuration options for the exponential interval scheduler.
 */
export type IntervalOptions = {
  /**
   * The initial delay in milliseconds before the first invocation.
   */
  interval: number;
  /**
   * The multiplier applied to the delay after each successful invocation.
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
   * Subsequent invocations follow the exponential backoff schedule.
   */
  immediate?: boolean;
};

/**
 * Handle to control the lifecycle of the exponential timer.
 */
export type ExponentialTimer = {
  /**
   * Stops further scheduled invocations and clears any pending timeout.
   */
  destroy: () => void;
};

/**
 * Schedules repeated execution of an asynchronous task using exponential backoff.
 *
 * @template R The return type of the asyncFunction (unused by scheduler).
 * @param asyncFunction
 *   The function to invoke on each tick. It receives a `resetInterval` callback,
 *   which can be called to reset the backoff sequence (interval and attempt count).
 *   Async errors thrown by this function do not stop the scheduler, unless
 *   `maxAttempts` is reached.
 * @param options
 *   Configuration options:
 *   - `interval`: Initial delay before first invocation.
 *   - `multiplier`: Factor to multiply the delay after each call.
 *   - `maxInterval`: Maximum delay between invocations.
 *   - `maxAttempts`: Optional maximum number of calls (infinite by default).
 *   - `immediate`: If true, run first tick immediately (default: false).
 * @returns A controller object with a `destroy()` method to stop future invocations.
 *
 * @example
 * ```ts
 * const timer = exponentialIntervalAsync(async (reset) => {
 *   const success = await doWork();
 *   if (success) {
 *     reset(); // restart interval on success
 *   }
 * }, { interval: 1000, multiplier: 2, maxInterval: 16000, maxAttempts: 10, immediate: true });
 *
 * // stop after some time:
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
  let isRunning = false;
  // Universal timeout handle (works both in Node and browser)
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // Reset the backoff sequence to its initial values.
  const resetInterval = () => {
    currentInterval = interval;
    attemptCount = 0;
  };

  // Internal scheduler that invokes the async function and reschedules itself.
  const scheduler = async () => {
    if (stopped) return;
    if (attemptCount >= maxAttempts) return;
    if (isRunning) return;

    isRunning = true;
    try {
      await asyncFunction(resetInterval);
    } catch {
      // Async errors do not stop the scheduler; they are intentionally ignored.
    } finally {
      isRunning = false;
    }

    attemptCount++;
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
    destroy: () => {
      stopped = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    },
  };
};
