import { DynamicModule, Module } from '@nestjs/common';
import { ContextModule, ContextService } from '@easylayer/common/context';
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
      imports: [ContextModule],
      providers: [
        {
          provide: AppLogger,
          useFactory: (ctx: ContextService) => {
            return new AppLogger(ctx).child(componentName);
          },
          inject: [ContextService],
        },
      ],
      exports: [AppLogger],
    };
  }
}
