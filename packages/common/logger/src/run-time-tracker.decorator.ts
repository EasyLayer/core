import { createLogger } from './bunyan-logger.service';

interface MemoryUsage {
  [key: string]: string;
}

/**
 * Retrieves the current process memory usage formatted in megabytes.
 * @returns An object mapping memory usage keys to human-readable strings.
 */
function getMemoryUsage() {
  const used = process.memoryUsage();
  const result = Object.entries(used).reduce((acc: MemoryUsage, [key, value]) => {
    acc[key] = `${(value / 1024 / 1024).toFixed(2)} MB`;
    return acc;
  }, {} as MemoryUsage);
  return result;
}

/**
 * Options for configuring the runtime tracker decorator.
 */
export interface RuntimeTrackerParams {
  /**
   * Threshold in milliseconds to prefix log with "WARN:" if exceeded.
   */
  warningThresholdMs?: number;
  /**
   * Threshold in milliseconds to prefix log with "ERROR:" if exceeded.
   */
  errorThresholdMs?: number;
  /**
   * Whether to include memory usage in the log.
   */
  showMemory?: boolean;
}

/**
 * Method decorator that logs execution time and optional memory usage.
 * All logs are emitted at debug level with "TIME:", "WARN:" or "ERROR:" prefixes.
 *
 * @param params Configuration parameters for thresholds and memory display.
 * @returns MethodDecorator to apply on async methods.
 *
 * @example
 * ```ts
 * class ExampleService {
 *   @RuntimeTracker({ warningThresholdMs: 100, errorThresholdMs: 500, showMemory: true })
 *   async doWork() {
 *     // method body
 *   }
 * }
 * ```
 */
export function RuntimeTracker({
  warningThresholdMs,
  errorThresholdMs,
  showMemory = false,
}: RuntimeTrackerParams): MethodDecorator {
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value as (...args: any[]) => Promise<any>;

    descriptor.value = async function (...args: any[]) {
      // Initialize the logger ONLY when calling the method
      const log = createLogger();
      const start = performance.now();

      try {
        return await originalMethod.apply(this, args);
      } finally {
        const duration = Math.round(performance.now() - start);
        const context = `${target.constructor.name}.${String(key)}`;

        const meta: Record<string, unknown> = {
          context,
          timeMs: duration,
          ...(warningThresholdMs !== undefined && { warningThresholdMs }),
          ...(errorThresholdMs !== undefined && { errorThresholdMs }),
          ...(showMemory && { memory: getMemoryUsage() }),
        };

        if (errorThresholdMs !== undefined && duration > errorThresholdMs) {
          log.debug('ERROR: Execution exceeded error threshold', meta);
        } else if (warningThresholdMs !== undefined && duration > warningThresholdMs) {
          log.debug('WARN: Execution exceeded warning threshold', meta);
        } else {
          log.debug('TIME: Method execution time', meta);
        }
      }
    };

    return descriptor;
  };
}
