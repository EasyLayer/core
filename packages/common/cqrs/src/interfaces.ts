export interface IEvent {}
export interface ICommand {}
export interface IQuery<R = any> {}

export interface IEventHandler<E extends IEvent = IEvent> {
  handle(event: E): Promise<any> | any;
}

export interface ICommandHandler<T extends ICommand = ICommand, R = any> {
  execute(command: T): Promise<R> | R; // convention: R = void
}

export interface IQueryHandler<T extends IQuery = IQuery, R = any> {
  execute(query: T): Promise<R> | R;
}

export type Type<T = any> = new (...args: any[]) => T;
