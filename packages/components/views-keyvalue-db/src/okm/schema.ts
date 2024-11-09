type PathType = 'static' | 'dynamic';

interface PathDefinition {
  type: PathType;
  required: boolean;
  // separator?: string;
  value?: string; // только для статического типа
}

interface ValueDefinition {
  type: string; // например, 'object', 'string', 'number', etc.
  fields?: Record<string, any>; // определение полей для типа 'object'
}

interface Relation {
  target: string; // имя целевой схемы
  join_paths: { name: string; referencedPathName: string }[];
}

interface SchemaDefinition {
  prefix: string;
  separator: string;
  paths: Record<string, PathDefinition>;
  values: ValueDefinition;
  relations?: Record<string, Relation>;
}

export class Schema {
  prefix: string;
  separator: string;
  paths: Record<string, PathDefinition>;
  values: ValueDefinition;
  relations: Record<string, Relation>;

  constructor(definition: SchemaDefinition) {
    this.prefix = definition.prefix;
    this.separator = definition.separator;
    this.paths = definition.paths;
    this.values = definition.values;
    this.relations = definition.relations || {};
  }
}
