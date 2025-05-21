import { Test, TestingModule } from '@nestjs/testing';
import { NetworkTransportModule } from '../network-transport.module';

describe('NetworkTransportModule', () => {
  let networkTransportModule: NetworkTransportModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [NetworkTransportModule.forRoot({ isGlobal: false, transports: [] })],
    }).compile();

    networkTransportModule = module.get<NetworkTransportModule>(NetworkTransportModule);
  });

  it('should be defined', () => {
    expect(networkTransportModule).toBeDefined();
  });
});
