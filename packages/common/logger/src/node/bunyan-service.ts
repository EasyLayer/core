import * as bunyan from 'bunyan';
import chalk from 'chalk';
import * as fs from 'node:fs';
import type { LoggerOptions } from 'bunyan';
import { nameFromLevel } from 'bunyan';
import type { LogLevel, RootLoggerOptions } from '../core/types';

export type BunyanInstance = bunyan;

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
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map(deerrorize);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value)) out[k] = deerrorize(value[k]);
    return out;
  }
  return value;
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

    if (!prod) {
      const c = colorFor(level);
      const levelName = (nameFromLevel as any)[level]?.toUpperCase() || String(level);
      const comp = toStr(component ?? name); // ← безопасно
      const svc = serviceName ? toStr(serviceName) : '';
      const meth = methodName ? `.${toStr(methodName)}()` : '';
      const extra = args ? ` ${toStr(args)}` : ''; // ← покажем meta
      // eslint-disable-next-line no-console
      console.log(`${c(`[${levelName}]`)} ${ts} ${comp} ${svc}${meth} ${toStr(msg)}${extra}`);
      return;
    }

    const line =
      JSON.stringify({ ...m, time: ts, level: (nameFromLevel as any)[level], hostname: undefined }, replacer) + '\n';
    const file = process?.env?.LOGS_FILE;
    if (file) fs.promises.appendFile(file, line);
    else process.stdout.write(line);
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

type State = { root?: bunyan; enabled: boolean };
const state: State = { root: undefined, enabled: true };

export function configureRootBunyan(opts: RootLoggerOptions = {}) {
  state.enabled = opts.enabled !== false;
  if (!state.enabled) {
    state.root = bunyan.createLogger({ name: opts.name || 'App', level: bunyan.FATAL + 1 });
    return state.root!;
  }
  if (opts.filePath) process.env.LOGS_FILE = opts.filePath;

  const options: LoggerOptions = {
    name: opts.name || 'App',
    level: lvlMap[opts.level ?? 'info'],
    streams: [{ type: 'raw', stream: new BunyanStream() }],
  };
  state.root = bunyan.createLogger(options);
  return state.root!;
}

export function getRootBunyan() {
  if (!state.root) configureRootBunyan();
  return state.root!;
}

export function isLoggingEnabled() {
  return state.enabled;
}
