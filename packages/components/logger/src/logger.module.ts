import { DynamicModule, Module } from '@nestjs/common';
import { AppLogger } from './app-logger.service';

interface LoggerModuleOptions {
  name?: string;
  componentName: string;
}

@Module({})
export class LoggerModule {
  static forRoot({ componentName }: LoggerModuleOptions): DynamicModule {
    return {
      module: LoggerModule,
      providers: [
        {
          provide: AppLogger,
          useValue: new AppLogger().child(componentName),
        },
      ],
      exports: [AppLogger],
    };
  }
}
