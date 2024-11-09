import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule } from '@easylayer/components/cqrs';
import { NetworkTransportModule } from '../network-transport.module';

describe('NetworkTransportModule', () => {
  let networkTransportModule: NetworkTransportModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true }), NetworkTransportModule],
    }).compile();

    networkTransportModule = module.get<NetworkTransportModule>(NetworkTransportModule);
  });

  it('should be defined', () => {
    expect(networkTransportModule).toBeDefined();
  });
});
