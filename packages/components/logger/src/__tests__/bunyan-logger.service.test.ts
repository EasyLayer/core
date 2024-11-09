import { BunyanStream } from '../bunyan-logger.service';

describe('BunyanStream', () => {
  it('should format log messages correctly', () => {
    const stream = new BunyanStream();
    const mockWrite = jest.spyOn(process.stdout, 'write');
    const logMessage = {
      level: 30,
      time: new Date(),
      msg: 'Test message',
      hostname: 'localhost',
    };

    stream.write(logMessage);

    const expectedOutput = {
      ...logMessage,
      time: logMessage.time.toISOString(),
      level: 'info',
      hostname: undefined,
    };

    expect(mockWrite).toHaveBeenCalledWith(JSON.stringify(expectedOutput) + '\n');
    mockWrite.mockRestore();
  });
});
