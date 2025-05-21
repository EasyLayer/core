import type { OutgoingMessage } from './interfaces';

/**
 * Abstract producer contract for sending outgoing messages.
 */
export abstract class BaseProducer<M extends OutgoingMessage = OutgoingMessage> {
  /**
   * Send a message via the underlying transport.
   * @param message Outgoing message payload
   */
  async sendMessage(message: M, options?: any): Promise<void> {
    throw new Error('The sendMessage() method is not implemented for this provider.');
  }
}
