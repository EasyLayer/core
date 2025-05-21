import { Module, Global } from '@nestjs/common';
import { ContextService } from './context.service';

@Global()
@Module({
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
