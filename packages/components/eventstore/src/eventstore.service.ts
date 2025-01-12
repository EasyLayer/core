import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class EventStoreService {
  constructor(private dataSource: DataSource) {}
}
