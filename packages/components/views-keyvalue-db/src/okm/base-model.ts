export abstract class BaseModel {
  serialize(): string {
    return JSON.stringify(this);
  }

  static deserialize(data: string): any {
    return JSON.parse(data);
  }
}
