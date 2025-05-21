import { Injectable } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { ExplorerService } from '@nestjs/cqrs/dist/services/explorer.service';
import type { CqrsOptions } from '@nestjs/cqrs/dist/interfaces/cqrs-options.interface';
import { setEventMetadataByHandlers, setQueryMetadataByHandlers } from './utils';
import type { BasicEvent, EventBasePayload } from './basic-event';

export interface IExtendedOptions extends CqrsOptions {}

@Injectable()
export class CustomExplorerService<
  E extends BasicEvent<EventBasePayload> = BasicEvent<EventBasePayload>,
> extends ExplorerService<E> {
  private customModulesContainer: ModulesContainer;

  constructor(modulesContainer: ModulesContainer) {
    super(modulesContainer);
    this.customModulesContainer = modulesContainer;
  }

  explore(): IExtendedOptions {
    const baseOptions = super.explore();

    // const modules = [...this.customModulesContainer.values()];
    // const projectionUpdaters = this.flatMap<IProjectionUpdater>(modules, (instance) => this.filterProvider(instance, PROJECTION_UPDATER_METADATA));

    const { events, queries } = baseOptions;

    if (events) {
      setEventMetadataByHandlers(events);
    }

    if (queries) {
      setQueryMetadataByHandlers(queries);
    }

    return { ...baseOptions, events };
  }
}
