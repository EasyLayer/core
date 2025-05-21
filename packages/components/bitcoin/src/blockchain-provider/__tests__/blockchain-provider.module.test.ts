import { Test, TestingModule } from '@nestjs/testing';
import { BlockchainProviderModule, BlockchainProviderModuleOptions } from '../blockchain-provider.module';
import { BlockchainProviderService } from '../blockchain-provider.service';
import { ConnectionManager } from '../connection-manager';
import { WebhookStreamService } from '../webhook-stream.service';

describe('BlockchainProviderModule', () => {
  let module: TestingModule;
  let service: BlockchainProviderService;

  const moduleOptions: BlockchainProviderModuleOptions = {
    isGlobal: false,
    selfNodesUrl: 'http://localhost',
  };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [BlockchainProviderModule.forRootAsync(moduleOptions)],
    }).compile();

    service = module.get<BlockchainProviderService>(BlockchainProviderService);
  });

  it('should compile the module', () => {
    expect(module).toBeDefined();
  });

  it('should have BlockchainProviderService', () => {
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(BlockchainProviderService);
  });

  it('should have ConnectionManager', () => {
    const connectionManager = module.get<ConnectionManager>(ConnectionManager);
    expect(connectionManager).toBeDefined();
    expect(connectionManager).toBeInstanceOf(ConnectionManager);
  });

  it('should have WebhookStreamService', () => {
    const webhookStreamService = module.get<WebhookStreamService>(WebhookStreamService);
    expect(webhookStreamService).toBeDefined();
    expect(webhookStreamService).toBeInstanceOf(WebhookStreamService);
  });

  // Add more tests for specific methods of the services if needed
});
