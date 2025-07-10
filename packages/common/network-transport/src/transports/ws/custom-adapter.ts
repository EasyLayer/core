import type { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { WsServerOptions } from './ws.module';

export class CustomWsAdapter extends IoAdapter {
  private wsOptions: WsServerOptions;

  constructor(
    private app: INestApplication,
    wsOptions: WsServerOptions
  ) {
    super(app);
    this.wsOptions = wsOptions;
  }

  create(port: number, options?: any): any {
    // Apply our options to Socket.IO server
    const serverOptions = {
      ...options,
      // Override CORS from our options
      cors: this.wsOptions.cors || {
        origin: '*',
        credentials: false,
      },

      // Override path from our options
      path: this.wsOptions.path || '/socket.io',

      // Other Socket.IO options
      pingTimeout: this.wsOptions.heartbeatTimeout || 10000,
      pingInterval: (this.wsOptions.heartbeatTimeout || 10000) / 2,

      // Maximum message size
      maxHttpBufferSize: this.wsOptions.maxMessageSize || 1024 * 1024,
    };

    // Use port from our options or default
    const finalPort = this.wsOptions.port || port;

    return super.create(finalPort, serverOptions);
  }

  createIOServer(port: number, options?: any): any {
    // Apply options here too
    const finalPort = this.wsOptions.port || port;
    const finalOptions = {
      ...options,
      cors: this.wsOptions.cors || {
        origin: '*',
        credentials: false,
      },
      path: this.wsOptions.path || '/socket.io',
      pingTimeout: this.wsOptions.heartbeatTimeout || 10000,
      pingInterval: (this.wsOptions.heartbeatTimeout || 10000) / 2,
      maxHttpBufferSize: this.wsOptions.maxMessageSize || 1024 * 1024,
    };

    return super.createIOServer(finalPort, finalOptions);
  }
}
