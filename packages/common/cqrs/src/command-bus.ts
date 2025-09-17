import { Injectable } from '@nestjs/common';
import type { ICommand, ICommandHandler, Type } from './interfaces';
import { COMMAND_HANDLER_METADATA } from './constants';

/**
 * - Matches command by constructor name to a single handler.
 * - Convention: commands return void (but generic R is allowed).
 * - Errors are propagated to the caller (NOT to UnhandledExceptionBus).
 */

@Injectable()
export class CommandBus<C extends ICommand = ICommand> {
  private readonly handlers = new Map<string, ICommandHandler<C>>();

  bind<H extends ICommandHandler<C>>(handler: H, name: string) {
    this.handlers.set(name, handler);
  }

  async execute<T extends C, R = any>(command: T): Promise<R> {
    const key = (command as any)?.constructor?.name;
    const h = key ? this.handlers.get(key) : undefined;
    if (!h) throw new Error(`No command handler for ${key}`);
    return await Promise.resolve(h.execute(command) as any);
  }

  registerInstances(handlers: ICommandHandler[]) {
    for (const h of handlers) {
      const ctor = (h as any).constructor as Type;
      const cmd: Type | undefined = Reflect.getMetadata(COMMAND_HANDLER_METADATA, ctor);
      if (cmd) this.bind(h as any, cmd.name);
    }
  }
}
