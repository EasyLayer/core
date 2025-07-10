import type { OutgoingMessage } from '../shared';

export interface IProducer {
  sendMessage(message: OutgoingMessage, options?: any): Promise<void>;
  isConnected(): boolean;
  markPong(): void;
}

/**
 * Abstract producer contract for sending outgoing messages.
 */
export abstract class BaseProducer<M extends OutgoingMessage = OutgoingMessage> implements IProducer {
  /**
   * Send a message via the underlying transport.
   * @param message Outgoing message payload
   * @param options Transport-specific options
   */
  async sendMessage(message: M, options?: any): Promise<void> {
    throw new Error('The sendMessage() method is not implemented for this producer.');
  }

  /**
   * Check if the transport is connected and ready to send messages.
   */
  abstract isConnected(): boolean;

  /**
   * Mark reception of pong from client.
   */
  abstract markPong(): void;

  /**
   * Send ping message to client (optional implementation)
   */
  async sendPing?(): Promise<void> {
    // Optional method for transports that support ping
  }

  /**
   * Get transport type name for logging
   */
  get transportType(): string {
    return this.constructor.name.replace('Producer', '').toLowerCase();
  }
}
