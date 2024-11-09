import { Inject } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
} from '@nestjs/websockets';
import { BasicMessage } from '@easylayer/common/domain-cqrs-components';
import { WebsocketMessage } from '@easylayer/common/domain-cqrs-components/websocket-messages';
import { EventBus, CustomEventBus } from '@easylayer/components/cqrs';

@WebSocketGateway({
  cors: { credentials: false, origin: '*' },
})
export class WebsocketMessagesGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    @Inject(EventBus)
    private readonly eventBus: CustomEventBus
  ) {}

  @WebSocketServer() server!: Server;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  afterInit(server: Server) {
    console.log('WebSocket server is up and running!');
  }

  @SubscribeMessage('message')
  public handleMessage<T>(@MessageBody() { payload }: BasicMessage<T>): void {
    this.eventBus.publish(new WebsocketMessage(payload));
  }

  public async sendMessageToAll<T>(payload: BasicMessage<T>): Promise<void> {
    const msg = this.prepareMessageString(payload);

    this.server.send(msg);
  }

  public async handleConnection(socket: Socket): Promise<void> {
    console.log(`Client connected: ${socket.id}\n`);
  }
  public async handleDisconnect(socket: Socket): Promise<void> {
    console.log(`Client disconnected: ${socket.id}\n`);
  }

  private prepareMessageString<T>(payload: BasicMessage<T>): string {
    const message = {
      channel: 'message',
      payload,
    };

    return JSON.stringify(message);
  }
}
