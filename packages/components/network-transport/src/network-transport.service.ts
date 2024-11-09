import { Injectable, Inject } from '@nestjs/common';
import { INetworkTransportService } from '@easylayer/common/shared-interfaces';
import { QueryBus, IQuery } from '@easylayer/components/cqrs';

@Injectable()
export class NetworkTransportService implements INetworkTransportService {
  constructor(
    @Inject(QueryBus)
    private readonly queryBus: QueryBus
  ) {}

  async executeQuery(queryName: string, params: any) {
    // TODO: add a checks for new constructor
    const query: IQuery = { ...params };
    query.constructor = { name: queryName } as typeof Object.constructor;

    return this.queryBus.execute(Object.assign(Object.create(query)));
  }
}
