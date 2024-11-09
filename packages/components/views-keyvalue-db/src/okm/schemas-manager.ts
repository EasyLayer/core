import { Injectable } from '@nestjs/common';
import { Schema } from './schema';

@Injectable()
export class SchemasManager {
  private schemas: Map<string, Schema>;

  constructor(schemas: Schema[]) {
    this.schemas = new Map();
    schemas.forEach((schema) => {
      this.schemas.set(schema.prefix, schema);
    });
  }

  // Метод для извлечения схемы на основе полного ключа или префикса
  getSchema(key: string): Schema | undefined {
    // Извлекаем префикс из ключа, если ключ передан полный
    const prefix = this.extractPrefixFromKey(key);
    return this.schemas.get(prefix);
  }

  // Метод для получения всех связей схемы
  getRelations(schema: Schema): any {
    return schema.relations;
  }

  // Вспомогательный метод для извлечения префикса из полного ключа
  private extractPrefixFromKey(key: string): string {
    // Предполагаем, что префикс - это часть ключа до первого separator
    const separatorIndex = key.indexOf(':');
    if (separatorIndex === -1) {
      // Если separator не найден, возвращаем весь ключ как префикс
      return key;
    }
    return key.substring(0, separatorIndex);
  }
}
