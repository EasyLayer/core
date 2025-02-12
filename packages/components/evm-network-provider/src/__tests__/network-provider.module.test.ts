import { Test, TestingModule } from '@nestjs/testing';
import { NetworkProviderModule, NetworkProviderModuleOptions } from '../network-provider.module';
import { NetworkProviderService } from '../network-provider.service';
import { ConnectionManager } from '../connection-manager';
import { NodeProviderTypes } from '../node-providers';

describe('NetworkProviderModule', () => {
  let module: TestingModule;
  let service: NetworkProviderService;

  const moduleOptions: NetworkProviderModuleOptions = {
    isGlobal: false,
    providers: [
      {
        connection: {
          type: NodeProviderTypes.ETHERJS,
          httpUrl: 'http://localhost',
        },
      },
    ],
  };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [NetworkProviderModule.forRootAsync(moduleOptions)],
    }).compile();

    service = module.get<NetworkProviderService>(NetworkProviderService);
  });

  it('should compile the module', () => {
    expect(module).toBeDefined();
  });

  it('should have NetworkProviderService', () => {
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(NetworkProviderService);
  });

  it('should have ConnectionManager', () => {
    const connectionManager = module.get<ConnectionManager>(ConnectionManager);
    expect(connectionManager).toBeDefined();
    expect(connectionManager).toBeInstanceOf(ConnectionManager);
  });

  // Add more tests for specific methods of the services if needed
});
