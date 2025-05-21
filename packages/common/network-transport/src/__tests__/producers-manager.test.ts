import { ProducersManager } from '../producers-manager';
import { BaseProducer } from '../base-producer';

describe('ProducersManager', () => {
  let manager: ProducersManager;
  let fakeProducer1: BaseProducer;
  let fakeProducer2: BaseProducer;

  const fakeLogger = {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
    setContext: jest.fn().mockReturnThis(),
  } as any;

  beforeEach(() => {
    fakeProducer1 = { sendMessage: jest.fn().mockResolvedValue(undefined) } as any;
    fakeProducer2 = { sendMessage: jest.fn().mockResolvedValue(undefined) } as any;
    manager = new ProducersManager(fakeLogger, [fakeProducer1, fakeProducer2]);
  });

  it('should broadcast events to all producers', async () => {
    // Define a simple event class so broadcast reads constructor name
    class TestEvent {
      constructor(public id: string) {}
    }
    const event = new TestEvent('abc-123');

    await manager.broadcast([event] as any);

    const expectedMessage = {
      action: 'batch',
      payload: [{ constructorName: 'TestEvent', dto: event }],
    };

    // Both producers should be called once with matching message
    expect(fakeProducer1.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeProducer1.sendMessage).toHaveBeenCalledWith(expectedMessage);
    expect(fakeProducer2.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeProducer2.sendMessage).toHaveBeenCalledWith(expectedMessage);
  });
});
