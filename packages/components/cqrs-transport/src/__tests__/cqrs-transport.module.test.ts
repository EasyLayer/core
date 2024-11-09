import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule } from '@easylayer/components/cqrs';
import { CqrsTransportModule } from '../cqrs-transport.module';

describe('CqrsTransportModule', () => {
  let cqrsTransportModule: CqrsTransportModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true }), CqrsTransportModule.forRoot({ isGlobal: false })],
    }).compile();

    cqrsTransportModule = module.get<CqrsTransportModule>(CqrsTransportModule);
  });

  it('should be defined', () => {
    expect(cqrsTransportModule).toBeDefined();
  });
});
