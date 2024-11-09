import { Schema } from './schema';

export const generateModelFromSchema = (schema: Schema) => {
  const { prefix } = schema;

  class DynamicModel {
    paths: Record<string, any>;
    values: Record<string, any>;
    relations: Record<string, any>; // Добавляем тип для relations

    constructor() {
      this.paths = {};
      this.values = {};
      this.relations = {};

      // Инициализация paths на основе схемы
      for (const [key, definition] of Object.entries(schema.paths)) {
        if (definition.type === 'static') {
          this.paths[key] = definition.value;
        } else if (definition.required) {
          this.paths[key] = null; // обязательные поля инициализируются как null
        }
      }

      // Инициализация values на основе схемы
      if (schema.values.type === 'object' && schema.values.fields) {
        for (const [key] of Object.entries(schema.values.fields)) {
          this.values[key] = null; // все поля инициализируются как null
        }
      }

      // A local variable that will be hidden in the closure
      const operationsHistory: Array<{ method: string; params: any }> = [];

      // Сохранение операций в приватной переменной
      this.put = (paths: Record<any, any>, values: Record<any, any>) => {
        return new Promise<void>((resolve) => {
          this.paths = paths;
          this.values = values;
          const key = this.generateKey(); // Генерация ключа с валидацией
          operationsHistory.push({ method: 'put', params: { key, values } });
          resolve();
        });
      };

      this.del = (paths: Record<any, any>) => {
        return new Promise<void>((resolve) => {
          this.paths = paths;
          const key = this.generateKey(); // Генерация ключа с валидацией
          operationsHistory.push({ method: 'del', params: { key } });
          resolve();
        });
      };

      this.getOperationsHistory = () => operationsHistory.slice();

      this.clearOperationsHistory = () => {
        operationsHistory.length = 0;
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async put(paths: Record<any, any>, values: Record<any, any>) {}
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async del(paths: Record<any, any>) {}
    getOperationsHistory() {}
    clearOperationsHistory() {}

    // Метод для валидации обязательных полей
    public validateRequiredPaths() {
      for (const [key, definition] of Object.entries(schema.paths)) {
        if (definition.required && (this.paths[key] === undefined || this.paths[key] === null)) {
          throw new Error(`Missing required path part: ${key}`);
        }
      }
    }

    // Метод для генерации ключа на основе paths
    public generateKey(): string {
      this.validateRequiredPaths(); // Валидация обязательных полей перед генерацией ключа

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const pathSegments = Object.entries(schema.paths).map(([name, def]: [string, any]) => {
        return this.paths[name];
      });

      return `${schema.prefix}${schema.separator}${pathSegments.join(schema.separator)}`;
    }

    // Метод для разбора ключа и заполнения модели
    public parseKey(key: string) {
      const keyParts = key.replace(`${schema.prefix}${schema.separator}`, '').split(schema.separator);
      const pathEntries = Object.entries(schema.paths);

      pathEntries.forEach(([name, def], index) => {
        if (def.type !== 'static') {
          this.paths[name] = keyParts[index];
        }
      });
    }

    // Метод для разбора значения и заполнения модели
    public parseValue(value: any) {
      if (schema.values.type === 'object' && schema.values.fields) {
        Object.assign(this.values, value);
      }
    }
  }

  Object.defineProperty(DynamicModel, 'name', { value: prefix });

  return DynamicModel;
};
