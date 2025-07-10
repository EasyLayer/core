import { Test, TestingModule } from '@nestjs/testing';
import { TransportModule } from '../transport.module';

describe('TransportModule', () => {
  let transportModule: TransportModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TransportModule.forRoot({ isGlobal: false, transports: [] })],
    }).compile();

    transportModule = module.get<TransportModule>(TransportModule);
  });

  it('should be defined', () => {
    expect(transportModule).toBeDefined();
  });
});
