import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { ContextData } from './interfaces';

@Injectable()
export class ContextService {
  private readonly als = new AsyncLocalStorage<ContextData>();

  /**
   * Запускает новый контекст с переданными данными и выполняет callback внутри него.
   */
  run<T>(initial: ContextData, fn: () => T): T {
    return this.als.run(initial, fn);
  }

  /**
   * Получает значение по ключу из текущего контекста.
   */
  get<T = any>(key: keyof ContextData): T | undefined {
    const store = this.als.getStore();
    return store ? (store[key] as T) : undefined;
  }

  /**
   * Устанавливает или обновляет значение в текущем контексте.
   */
  set(key: keyof ContextData, value: any): void {
    const store = this.als.getStore();
    if (store) {
      store[key] = value;
    }
  }

  /**
   * Удаляет ключ из текущего контекста.
   */
  remove(key: keyof ContextData): void {
    const store = this.als.getStore();
    if (store && key in store) {
      delete store[key];
    }
  }

  /**
   * Создаёт функцию, привязанную к текущему контексту.
   */
  bind<T extends (...args: any[]) => any>(fn: T): T {
    const store = this.als.getStore();
    if (!store) {
      return fn;
    }
    const bound = (...args: any[]) => {
      return this.als.run(store, () => fn(...args));
    };
    return bound as T;
  }

  /**
   * Устанавливает новый пустой контекст с указанным requestId и типом.
   */
  init(requestId: string, type: ContextData['type']): void {
    this.als.enterWith({ requestId, type });
  }
}
