import { Test, TestingModule } from '@nestjs/testing';
import { ReadDatabaseModule } from '../read-database.module';

describe('ReadDatabaseModule', () => {
  let readDatabaseModule: ReadDatabaseModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ReadDatabaseModule],
    }).compile();

    readDatabaseModule = module.get<ReadDatabaseModule>(ReadDatabaseModule);
  });

  it('should be defined', () => {
    expect(readDatabaseModule).toBeDefined();
  });
});
