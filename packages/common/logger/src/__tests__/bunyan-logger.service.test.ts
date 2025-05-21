import { BunyanStream } from '../bunyan-logger.service';

describe('BunyanStream', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'production';
  });
  afterAll(() => {
    delete process.env.NODE_ENV;
  });

  it('should format log messages correctly', () => {
    const stream = new BunyanStream();
    const mockWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logMessage = {
      name:     'Test',
      level:    30,
      time:     new Date(),
      msg:      'Test message',
      args:     undefined,
      context:  undefined,
      component: undefined,
    };

    stream.write(logMessage);

    const expected = {
      ...logMessage,
      time:     logMessage.time.toISOString(),
      level:    'info',
      hostname: undefined,
    };

    expect(mockWrite).toHaveBeenCalledWith(JSON.stringify(expected) + '\n');
    mockWrite.mockRestore();
  });
});

