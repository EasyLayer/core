// import { getRootLogger } from '../index';

// interface MemoryUsage { [key: string]: string; }

// function getMemoryUsage(): MemoryUsage | undefined {
//   // Node only
//   if (typeof process !== 'undefined' && typeof (process as any).memoryUsage === 'function') {
//     const used = process.memoryUsage();
//     const out: MemoryUsage = {};
//     for (const [k, v] of Object.entries(used)) {
//       out[k] = `${(Number(v) / 1024 / 1024).toFixed(2)} MB`;
//     }
//     return out;
//   }
//   return undefined;
// }

// export interface RuntimeTrackerParams {
//   /** Threshold in ms to emit WARN: message if exceeded. */
//   warningThresholdMs?: number;
//   /** Threshold in ms to emit ERROR: message if exceeded. */
//   errorThresholdMs?: number;
//   /** If true, includes Node memory usage snapshot in meta. */
//   showMemory?: boolean;
// }

// /**
//  * Method decorator that logs execution time and optional memory usage.
//  * All logs are emitted at DEBUG level with prefixes: "TIME:", "WARN:", "ERROR:".
//  *
//  * Notes:
//  * - Works with both async and sync methods.
//  * - Make sure root logger is configured BEFORE the decorated method is called.
//  */
// export function RuntimeTracker({
//   warningThresholdMs,
//   errorThresholdMs,
//   showMemory = false,
// }: RuntimeTrackerParams = {}): MethodDecorator {
//   return (_target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
//     const original = descriptor.value;

//     if (typeof original !== 'function') return descriptor;

//     descriptor.value = function (...args: any[]) {
//       const log = getRootLogger().child('RuntimeTracker');
//       const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
//         ? () => performance.now()
//         : () => Date.now();

//       const start = now();

//       const finish = () => {
//         const duration = Math.round(now() - start);
//         const meta: Record<string, unknown> = {
//           context: `${(this as any)?.constructor?.name ?? 'Unknown'}.${String(key)}`,
//           timeMs: duration,
//           ...(warningThresholdMs !== undefined && { warningThresholdMs }),
//           ...(errorThresholdMs !== undefined && { errorThresholdMs }),
//           ...(showMemory && { memory: getMemoryUsage() }),
//         };

//         if (errorThresholdMs !== undefined && duration > errorThresholdMs) {
//           log.debug('ERROR: Execution exceeded error threshold', meta);
//         } else if (warningThresholdMs !== undefined && duration > warningThresholdMs) {
//           log.debug('WARN: Execution exceeded warning threshold', meta);
//         } else {
//           log.debug('TIME: Method execution time', meta);
//         }
//       };

//       try {
//         const result = original.apply(this, args);
//         // Handle sync and async transparently
//         if (result && typeof result.then === 'function') {
//           return (result as Promise<any>).finally(finish);
//         }
//         finish();
//         return result;
//       } catch (e) {
//         // Even on thrown sync errors we still log duration
//         finish();
//         throw e;
//       }
//     };

//     return descriptor;
//   };
// }
