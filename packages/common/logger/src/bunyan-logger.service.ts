import * as bunyan from 'bunyan';
import chalk from 'chalk';
import * as fs from 'node:fs';
import type { LoggerOptions } from 'bunyan';
import { nameFromLevel } from 'bunyan';
export type { LoggerOptions };

export type LogLevels = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const VALID_LEVELS: Set<LogLevels> = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

export class BunyanStream {
  write(logMessage: any): void {
    const isProduction = process?.env?.NODE_ENV === 'production';

    const { name, time, level, msg, args, serviceName, methodName, component } = logMessage;

    const formattedTime = time ? time.toISOString() : new Date().toISOString();

    // Preparing the log object without hostname for structured logging
    const updatedLog = {
      ...logMessage,
      time: formattedTime,
      level: nameFromLevel[level],
      hostname: undefined,
    };

    if (!isProduction) {
      // In Development mode, output colored logs including specified parameters
      const levelColor = getColor(level);
      const coloredLevel = levelColor(`[${nameFromLevel[level]?.toUpperCase()}]`);

      const componentName = component ?? name;
      const servicePart = serviceName ? `${serviceName}` : '';
      const methodPart = methodName ? `.${methodName}()` : '';
      const argsString = args ? JSON.stringify(args, replacer, 2) : '';

      // eslint-disable-next-line no-console
      console.log(`${coloredLevel}: ${componentName} ${servicePart}${methodPart} ${msg}`, argsString);
    } else {
      // In Production mode, output structured JSON logs
      const result = JSON.stringify(updatedLog, replacer) + '\n';

      // In Production: write to stdout for bunyan, and optionally to file if path is provided
      const filePath = process?.env?.LOGS_FILE;
      if (filePath) {
        fs.promises.appendFile(filePath, result).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`Failed to write logs to file ${filePath}:`, err);
        });
      } else {
        process.stdout.write(result);
      }
    }
  }
}

function getColor(level: number): (text: string) => string {
  switch (level) {
    case bunyan.INFO:
      return chalk.blue;
    case bunyan.WARN:
      return chalk.green;
    case bunyan.ERROR:
      return chalk.red;
    case bunyan.DEBUG:
      return chalk.yellow;
    case bunyan.FATAL:
      return chalk.redBright;
    default:
      return chalk.white;
  }
}

function replacer(key: string, value: any) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

class LoggerSingleton {
  private static instance: bunyan | null = null;

  public static getInstance(name: string): bunyan {
    if (!LoggerSingleton.instance) {
      const raw = String(
        process.env.LOGS_LVL || process.env.DEBUG === '1' ? 'debug' : 'info'
      ).toLowerCase() as LogLevels;
      const level = VALID_LEVELS.has(raw) ? raw : 'info';

      const options: LoggerOptions = {
        name,
        level,
        streams: [
          {
            type: 'raw',
            stream: new BunyanStream(),
          },
        ],
      };

      LoggerSingleton.instance = bunyan.createLogger(options);
    }

    return LoggerSingleton.instance;
  }
}

export function createLogger(name: string = 'System'): bunyan {
  return LoggerSingleton.getInstance(name);
}

export type BunyanInstance = bunyan;
