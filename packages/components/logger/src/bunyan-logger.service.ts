import * as bunyan from 'bunyan';
import { LoggerOptions, nameFromLevel } from 'bunyan';
export { LoggerOptions };
import chalk from 'chalk';

export class BunyanStream {
  write(logMessage: any): void {
    const isDevelopment = process.env.NODE_ENV === 'development';

    // Destructuring to separate time, hostname, level, and msg from extra parameters
    const { name, time, level, msg, args, context, component } = logMessage;
    const formattedTime = time ? time.toISOString() : new Date().toISOString();

    // Preparing the log object without hostname for structured logging
    const updatedLog = {
      ...logMessage,
      time: formattedTime,
      level: nameFromLevel[level],
      hostname: undefined,
    };

    if (isDevelopment) {
      // In Development mode, output colored logs including specified parameters
      const levelColor = this.getColor(level);
      const coloredLevel = levelColor(`[${nameFromLevel[level].toUpperCase()}]`);

      const argsString = args ? JSON.stringify(args, replacer, 2) : '';
      const contextString = context ? JSON.stringify(context, replacer, 2) : '';
      const componentName = component ? component : name;

      // Building messages
      console.log(`${coloredLevel}: ${componentName} ${contextString} ${msg}`, argsString);
    } else {
      // In Production mode, output structured JSON logs
      const result = JSON.stringify(updatedLog, replacer) + '\n';
      process.stdout.write(result);
    }
  }

  private getColor(level: number): (text: string) => string {
    switch (level) {
      case bunyan.INFO:
        return chalk.blue;
      case bunyan.WARN:
        return chalk.green;
      case bunyan.ERROR:
        return chalk.red;
      case bunyan.DEBUG:
        return chalk.yellow;
      default:
        return chalk.white;
    }
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
      const level = process.env.DEBUG === '1' ? 'debug' : 'info';

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
