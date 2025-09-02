import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CqrsModule as NestCqrsModule,
  EventBus,
  CommandBus,
  QueryBus,
  EventsHandler,
  IEventHandler,
  QueryHandler,
  IQueryHandler,
  CommandHandler,
  ICommandHandler,
  Saga,
} from '@nestjs/cqrs';
import { Observable, filter, map } from 'rxjs';
import { CustomCqrsModule } from '../custom-cqrs.module';

class TestEvent {}
class TestQuery {}
class TestCommand {}

@EventsHandler(TestEvent)
class EHandler implements IEventHandler<TestEvent> {
  handle(_event: TestEvent) { /* no-op */ }
}

@QueryHandler(TestQuery)
class QHandler implements IQueryHandler<TestQuery, any> {
  async execute(_query: TestQuery) { return 'ok'; }
}

@CommandHandler(TestCommand)
class CHandler implements ICommandHandler<TestCommand> {
  async execute(_cmd: TestCommand) { /* no-op */ }
}

class SagaHost {
  @Saga()
  testSaga = (events$: Observable<any>) =>
    events$.pipe(
      filter((e) => e instanceof TestEvent),
      map(() => new TestCommand()),
    );
}

@Module({
  imports: [NestCqrsModule],
  providers: [EHandler, QHandler, CHandler, SagaHost],
})
class FeatureModule {}

describe('CustomCQRSModule', () => {
  it('register handlers/sagas в onModuleInit', async () => {
    const testingModule = await Test.createTestingModule({
      imports: [
        FeatureModule,
        CustomCqrsModule.forRoot({ isGlobal: false }),
      ],
    }).compile();

    const eventBus = testingModule.get<EventBus>(EventBus);
    const commandBus = testingModule.get<CommandBus>(CommandBus);
    const queryBus = testingModule.get<QueryBus>(QueryBus);

    const spyEventRegister = jest.spyOn(eventBus, 'register');
    const spySagasRegister = jest.spyOn(eventBus, 'registerSagas');
    const spyCommandRegister = jest.spyOn(commandBus, 'register');
    const spyQueryRegister = jest.spyOn(queryBus, 'register');

    await testingModule.init();

    expect(spyEventRegister).toHaveBeenCalled();
    expect(spyCommandRegister).toHaveBeenCalled();
    expect(spyQueryRegister).toHaveBeenCalled();
    expect(spySagasRegister).toHaveBeenCalled();

    const evArgs = spyEventRegister.mock.calls.flat();
    const evRegisteredClasses: any[] = evArgs.flat();
    expect(evRegisteredClasses).toContain(EHandler);

    const cmdArgs = spyCommandRegister.mock.calls.flat();
    const cmdRegisteredClasses: any[] = cmdArgs.flat();
    expect(cmdRegisteredClasses).toContain(CHandler);

    const qArgs = spyQueryRegister.mock.calls.flat();
    const qRegisteredClasses: any[] = qArgs.flat();
    expect(qRegisteredClasses).toContain(QHandler);

    const sagasArgs = spySagasRegister.mock.calls.flat();
    const sagasRegistered: any[] = sagasArgs.flat();
    const someSagaIsFn = sagasRegistered.some((s) => typeof s === 'function');
    expect(someSagaIsFn).toBe(true);
  });
});
