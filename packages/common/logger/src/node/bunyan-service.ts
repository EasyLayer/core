import * as bunyan from 'bunyan';
import chalk from 'chalk';
import * as fs from 'node:fs';
import type { LoggerOptions } from 'bunyan';
import { nameFromLevel } from 'bunyan';
import type { LogLevel, RootLoggerOptions } from '../core/types';
import { sanitizeLogValue } from '../core/sanitize';

export type BunyanInstance = bunyan;

function memNow() {
  // @ts-ignore
  if (typeof process === 'undefined' || typeof process.memoryUsage !== 'function') return undefined;
  const mu = process.memoryUsage();
  const toMB = (b: number | undefined) => Math.round(((b || 0) / 1048576) * 10) / 10;
  return {
    rssMB: toMB(mu.rss),
    heapUsedMB: toMB(mu.heapUsed),
  };
}

function replacer(_k: string, v: any) {
  return typeof v === 'bigint' ? String(v) : v;
}

function toStr(x: any): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'function') return x.name || '[fn]';
  try {
    return JSON.stringify(x, replacer);
  } catch {
    return String(x);
  }
}

export function deerrorize(value: any): any {
  return sanitizeLogValue(value);
}

function colorFor(level: number) {
  switch (level) {
    case bunyan.TRACE:
      return chalk.gray;
    case bunyan.DEBUG:
      return chalk.yellow;
    case bunyan.INFO:
      return chalk.blue;
    case bunyan.WARN:
      return chalk.green;
    case bunyan.ERROR:
      return chalk.red;
    case bunyan.FATAL:
      return chalk.redBright;
    default:
      return chalk.white;
  }
}

class BunyanStream {
  write(m: any): void {
    const prod = process?.env?.NODE_ENV === 'production';
    const { name, time, level, msg, args, serviceName, methodName, component } = m;
    const ts = time ? time.toISOString() : new Date().toISOString();

    const mem = level === bunyan.INFO ? memNow() : undefined;

    if (!prod) {
      const c = colorFor(level);
      const levelName = (nameFromLevel as any)[level]?.toUpperCase() || String(level);
      const comp = toStr(component ?? name);
      const svc = serviceName ? toStr(serviceName) : '';
      const meth = methodName ? `.${toStr(methodName)}()` : '';
      const meta = (() => {
        if (args && mem) return ` ${toStr({ ...args, mem })}`;
        if (args) return ` ${toStr(args)}`;
        if (mem) return ` ${toStr({ mem })}`;
        return '';
      })();

      // eslint-disable-next-line no-console
      console.log(`${c(`[${levelName}]`)} ${ts} ${comp} ${svc}${meth} ${toStr(msg)}${meta}`);
      return;
    }

    const line =
      JSON.stringify(
        {
          ...m,
          ...(mem ? { mem } : {}),
          time: ts,
          level: (nameFromLevel as any)[level],
          hostname: undefined,
        },
        replacer
      ) + '\n';

    // Prefer filePath set via configureRootBunyan (stored in state).
    // Fall back to LOGS_FILE env var for Docker/production config without code changes.
    // Never mutate process.env — state.filePath is the authoritative in-code setting.
    const file = state.filePath ?? process?.env?.LOGS_FILE;
    if (file) {
      fs.promises.appendFile(file, line).catch(() => {
        // Silent catch: if the file is not writable, logs go to stdout only.
        // Recursive logging is not possible here — logger cannot log its own errors.
        process.stdout.write(line);
      });
    } else {
      process.stdout.write(line);
    }
  }
}

const lvlMap: Record<LogLevel, bunyan.LogLevel> = {
  trace: bunyan.TRACE,
  debug: bunyan.DEBUG,
  info: bunyan.INFO,
  warn: bunyan.WARN,
  error: bunyan.ERROR,
  fatal: bunyan.FATAL,
};

// filePath is stored in state, not in process.env, to avoid global side effects.
type State = { root?: bunyan; enabled: boolean; filePath?: string };
const state: State = { root: undefined, enabled: true };

export function configureRootBunyan(opts: RootLoggerOptions) {
  state.enabled = opts.enabled !== false;
  if (!state.enabled) {
    state.root = bunyan.createLogger({ name: opts.name || 'app', level: bunyan.FATAL + 1 });
    return state.root!;
  }

  // Store filePath in state instead of mutating process.env.
  // process.env.LOGS_FILE is still supported as an env-var fallback (read in BunyanStream.write).
  if (opts.filePath) state.filePath = opts.filePath;

  const options: LoggerOptions = {
    name: opts.name || 'app',
    level: lvlMap[opts.level ?? 'info'],
    streams: [{ type: 'raw', stream: new BunyanStream() }],
  };
  state.root = bunyan.createLogger(options);
  return state.root!;
}

export function getRootBunyan(opts: RootLoggerOptions) {
  if (!state.root) configureRootBunyan(opts);
  return state.root!;
}

export function isLoggingEnabled() {
  return state.enabled;
}
