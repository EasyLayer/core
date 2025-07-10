import { Test, TestingModule } from '@nestjs/testing';
import { LoggerModule } from '@easylayer/common/logger';
import { CqrsModule } from '@easylayer/common/cqrs';
import { TransportModule } from '@easylayer/common/network-transport';
import { CqrsTransportModule } from '../cqrs-transport.module';

describe('CqrsTransportModule', () => {
  let cqrsTransportModule: CqrsTransportModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ componentName: 'CqrsTransportModule' }),
        CqrsModule.forRoot({ isGlobal: true }),
        CqrsTransportModule.forRoot({ isGlobal: true }),
        TransportModule.forRoot({ isGlobal: true, transports: [] }),
      ],
    }).compile();

    cqrsTransportModule = module.get<CqrsTransportModule>(CqrsTransportModule);
  });

  it('should be defined', () => {
    expect(cqrsTransportModule).toBeDefined();
  });
});
