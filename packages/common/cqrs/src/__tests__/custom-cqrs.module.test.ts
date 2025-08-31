import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { CustomCqrsModule } from "../custom-cqrs.module";
import { CommandBus, EventBus, QueryBus } from "@nestjs/cqrs";
import { CustomExplorerService } from "../custom-explorer.service";

describe("CustomCQRSModule", () => {
  it("wires explorer -> buses onModuleInit", async () => {
    const events = [class H1 {} as any];
    const queries = [class Q1 {} as any];
    const sagas = [class S1 {} as any];
    const commands = [class C1 {} as any];

    const explorerService = { explore: jest.fn(() => ({ events, queries, sagas, commands })) };
    const eventBus = { register: jest.fn(), registerSagas: jest.fn() };
    const commandBus = { register: jest.fn() };
    const queryBus = { register: jest.fn() };

    const modref = await Test.createTestingModule({
      imports: [CustomCqrsModule.forRoot({ isGlobal: false })],
    })
      .overrideProvider(CustomExplorerService)
      .useValue(explorerService as any)
      .overrideProvider(EventBus)
      .useValue(eventBus as any)
      .overrideProvider(CommandBus)
      .useValue(commandBus as any)
      .overrideProvider(QueryBus)
      .useValue(queryBus as any)
      .compile();

    const moduleInstance = modref.get(CustomCqrsModule);

    moduleInstance.onModuleInit();

    expect(eventBus.register).toHaveBeenCalledWith(events);
    expect(eventBus.registerSagas).toHaveBeenCalledWith(sagas);
    expect(commandBus.register).toHaveBeenCalledWith(commands);
    expect(queryBus.register).toHaveBeenCalledWith(queries);
  });
});
