import { Test, TestingModule } from '@nestjs/testing';
import { SecureStorageModule } from '../secure-storage.module';

describe('SecureStorageModule', () => {
  let secureStorageModule: SecureStorageModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [SecureStorageModule],
    }).compile();

    secureStorageModule = module.get<SecureStorageModule>(SecureStorageModule);
  });

  it('should be defined', () => {
    expect(secureStorageModule).toBeDefined();
  });
});
