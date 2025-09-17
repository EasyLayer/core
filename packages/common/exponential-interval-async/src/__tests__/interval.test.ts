import { exponentialIntervalAsync } from '../interval';

describe('exponentialIntervalAsync', () => {
  beforeEach(() => {
    jest.useFakeTimers(); // Use fake timers to control the timing in tests
  });

  afterEach(() => {
    jest.runOnlyPendingTimers(); // Run any pending timers to clean up
    jest.useRealTimers(); // Restore real timers after each test
  });

  it('should call asyncFunction at least once', async () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined); // Mock async function that resolves successfully
    const options = { interval: 100, multiplier: 2, maxInterval: 1000 };

    const timer = exponentialIntervalAsync(asyncFunc, options);

    // First call after 100 ms
    jest.advanceTimersByTime(100);
    // Wait for the asynchronous function to complete
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(1);

    // Destroy the timer to clean up
    timer.destroy();
  });

  it('should stop after reaching maxAttempts', async () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined);
    const options = { interval: 100, multiplier: 2, maxInterval: 1000, maxAttempts: 3 };

    const timer = exponentialIntervalAsync(asyncFunc, options);

    // 1st call after 100 ms
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(1);

    // 2nd call after 200 ms
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(2);

    // 3rd call after 400 ms
    jest.advanceTimersByTime(400);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(3);

    // 4th call should not occur since maxAttempts = 3
    jest.advanceTimersByTime(800);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(3);

    // Destroy the timer to clean up
    timer.destroy();
  });

  it('should exponentially increase the interval', async () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined);
    const options = { interval: 100, multiplier: 2, maxInterval: 800, maxAttempts: 4 };

    const timer = exponentialIntervalAsync(asyncFunc, options);

    // 1st call after 100 ms
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(1);

    // 2nd call after 200 ms
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(2);

    // 3rd call after 400 ms
    jest.advanceTimersByTime(400);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(3);

    // 4th call after 800 ms (maximum interval)
    jest.advanceTimersByTime(800);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(4);

    // Additional time should not trigger more calls
    jest.advanceTimersByTime(1600);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(4);

    // Destroy the timer to clean up
    timer.destroy();
  });

  it('should not exceed maxInterval', async () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined);
    const options = { interval: 100, multiplier: 2, maxInterval: 400, maxAttempts: 4 };

    const timer = exponentialIntervalAsync(asyncFunc, options);

    // 1st call after 100 ms
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(1);

    // 2nd call after 200 ms
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(2);

    // 3rd call after 400 ms (maximum interval)
    jest.advanceTimersByTime(400);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(3);

    // 4th call also after 400 ms (does not exceed maxInterval)
    jest.advanceTimersByTime(400);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(4);

    // Destroy the timer to clean up
    timer.destroy();
  });

  it('should handle manual destruction to stop further calls', async () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined);
    const options = { interval: 100, multiplier: 2, maxInterval: 1000, maxAttempts: 5 };

    const timer = exponentialIntervalAsync(asyncFunc, options);

    // 1st call after 100 ms
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(1);

    // 2nd call after 200 ms
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(2);

    // Call destroy to stop further executions
    timer.destroy();

    // Advancing time should not trigger additional calls
    jest.advanceTimersByTime(400);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(2);
  });

  it('should throw an error if maxInterval is less than initial interval', () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined);
    const options = { interval: 200, multiplier: 2, maxInterval: 100 };

    expect(() => exponentialIntervalAsync(asyncFunc, options)).toThrow(
      'maxInterval cannot be less than initial interval'
    );
  });

  it('should handle multiplier less than or equal to 1 by maintaining the interval', async () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined);
    const options = { interval: 100, multiplier: 1, maxInterval: 1000, maxAttempts: 3 };

    const timer = exponentialIntervalAsync(asyncFunc, options);

    // 1st call after 100 ms
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(1);

    // 2nd call after another 100 ms (multiplier = 1, interval remains the same)
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(2);

    // 3rd call after another 100 ms
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(3);

    // Further calls should not occur as maxAttempts = 3
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(asyncFunc).toHaveBeenCalledTimes(3);

    // Destroy the timer to clean up
    timer.destroy();
  });

  it('should call asyncFunction immediately upon creation', async () => {
    const asyncFunc = jest.fn().mockResolvedValue(undefined);
    const options = { interval: 100, multiplier: 2, maxInterval: 1000, maxAttempts: 3, immediate: true };

    const timer = exponentialIntervalAsync(asyncFunc, options);

    // Wait a microtask turn to allow the immediate async call to resolve
    await Promise.resolve();

    expect(asyncFunc).toHaveBeenCalledTimes(1);

    timer.destroy();
  });
});
