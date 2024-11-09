import { createLogger } from './bunyan-logger.service';

interface MemoryUsage {
  [key: string]: string;
}

function getMemoryUsage() {
  const used = process.memoryUsage();
  const result = Object.entries(used).reduce((acc: MemoryUsage, [key, value]) => {
    acc[key] = `${(value / 1024 / 1024).toFixed(2)} MB`;
    return acc;
  }, {} as MemoryUsage);
  return result;
}

export interface RuntimeTrackerParams {
  warningThresholdMs?: number;
  errorThresholdMs?: number;
  showMemory?: boolean;
}

export function RuntimeTracker({
  warningThresholdMs,
  errorThresholdMs,
  showMemory = false,
}: RuntimeTrackerParams): MethodDecorator {
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Initialize the logger ONLY when calling the method
      const log = createLogger();
      const start = Date.now();

      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        throw error;
      } finally {
        if (process.env.DEBUG === '1') {
          const time = Date.now() - start;
          const context = `${target.constructor.name}.${String(key)}`;
          const logArgs: any = {
            time: `${time} ms`,
          };

          if (showMemory) {
            logArgs.memory = getMemoryUsage();
          }
          if (warningThresholdMs !== undefined) {
            logArgs.warningThresholdMs = warningThresholdMs;
          }
          if (errorThresholdMs !== undefined) {
            logArgs.errorThresholdMs = errorThresholdMs;
          }

          if (errorThresholdMs && time > errorThresholdMs) {
            log.error('Method takes too long to execute', logArgs, context);
          } else if (warningThresholdMs && time > warningThresholdMs) {
            log.warn('Method takes too long to execute', logArgs, context);
          } else {
            log.debug('Time:', logArgs, context);
          }
        }
      }
    };

    return descriptor;
  };
}
