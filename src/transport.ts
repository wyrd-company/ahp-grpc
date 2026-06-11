import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import {
  ChannelCredentials,
  Client,
  Metadata,
  Server,
  ServerCredentials,
  type ClientDuplexStream,
  type ServerDuplexStream,
  type ServiceDefinition,
  type UntypedServiceImplementation,
} from '@grpc/grpc-js';

import type { ServerTransport } from './types.js';

export interface GrpcFrame {
  readonly text: string;
}

export interface AhpGrpcUdsServerOptions {
  readonly socketPath: string;
  readonly unlinkExisting?: boolean;
  readonly onTransport: (transport: ServerTransport) => void;
}

export interface AhpGrpcUdsClientTransportOptions {
  readonly socketPath: string;
}

const SERVICE_PATH = '/wyrd.ahp.transport.v1.AhpTransport/Connect';

export const ahpGrpcTransportServiceDefinition: ServiceDefinition = {
  Connect: {
    path: SERVICE_PATH,
    requestStream: true,
    responseStream: true,
    requestSerialize: serializeFrame,
    requestDeserialize: deserializeFrame,
    responseSerialize: serializeFrame,
    responseDeserialize: deserializeFrame,
  },
};

type StreamLike = {
  write(frame: GrpcFrame): boolean;
  end(): void;
  destroy(error?: Error): void;
  on(event: 'data', listener: (frame: GrpcFrame) => void): StreamLike;
  on(event: 'end' | 'close' | 'cancelled', listener: () => void): StreamLike;
  on(event: 'error', listener: (error: Error) => void): StreamLike;
};

class GrpcTextStreamTransport {
  private readonly inbox: Array<string | null> = [];
  private waiter: ((message: string | null) => void) | undefined;
  private closed = false;

  constructor(private readonly stream: StreamLike) {
    stream.on('data', frame => {
      this.deliver(frame.text);
    });
    stream.on('end', () => {
      this.markClosed();
    });
    stream.on('close', () => {
      this.markClosed();
    });
    stream.on('cancelled', () => {
      this.markClosed();
    });
    stream.on('error', () => {
      this.markClosed();
    });
  }

  sendText(text: string): void {
    if (this.closed) {
      throw new Error('gRPC transport closed');
    }
    this.stream.write({ text });
  }

  recvText(): Promise<string | null> {
    const next = this.inbox.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.markClosed();
    this.stream.end();
  }

  destroy(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.markClosed();
    this.stream.destroy(error);
  }

  private markClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.deliver(null);
  }

  private deliver(message: string | null): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(message);
      return;
    }
    this.inbox.push(message);
  }
}

export class GrpcServerTransport implements ServerTransport {
  private readonly inner: GrpcTextStreamTransport;

  constructor(call: ServerDuplexStream<GrpcFrame, GrpcFrame>) {
    this.inner = new GrpcTextStreamTransport(call);
  }

  send(message: JsonRpcMessage | string): void {
    this.inner.sendText(typeof message === 'string' ? message : JSON.stringify(message));
  }

  async recv(): Promise<TransportFrame | null> {
    const text = await this.inner.recvText();
    return text === null ? null : { kind: 'text', text };
  }

  close(): void {
    this.inner.close();
  }
}

export class GrpcAhpClientTransport implements AhpTransport {
  private readonly client: Client;
  private readonly call: ClientDuplexStream<GrpcFrame, GrpcFrame>;
  private readonly inner: GrpcTextStreamTransport;

  constructor(options: AhpGrpcUdsClientTransportOptions) {
    this.client = new Client(grpcUdsAddress(options.socketPath), ChannelCredentials.createInsecure());
    this.call = this.client.makeBidiStreamRequest(
      SERVICE_PATH,
      serializeFrame,
      deserializeFrame,
      new Metadata(),
    );
    this.inner = new GrpcTextStreamTransport(this.call);
  }

  ready(timeoutMs = 2_000): Promise<void> {
    return new Promise((resolveReady, reject) => {
      this.client.waitForReady(Date.now() + timeoutMs, error => {
        if (error) {
          reject(error);
          return;
        }
        resolveReady();
      });
    });
  }

  send(message: JsonRpcMessage | string): void {
    this.inner.sendText(typeof message === 'string' ? message : JSON.stringify(message));
  }

  async recv(): Promise<TransportFrame | null> {
    const text = await this.inner.recvText();
    return text === null ? null : { kind: 'text', text };
  }

  close(): void {
    this.inner.close();
    this.client.close();
  }
}

export class AhpGrpcUdsServer {
  private readonly server = new Server();
  private readonly transports = new Set<GrpcServerTransport>();
  private readonly socketPath: string;
  private boundAddress: string | undefined;

  constructor(private readonly options: AhpGrpcUdsServerOptions) {
    this.socketPath = resolve(options.socketPath);
    const implementation: UntypedServiceImplementation = {
      Connect: (call: ServerDuplexStream<GrpcFrame, GrpcFrame>) => {
        const transport = new GrpcServerTransport(call);
        this.transports.add(transport);
        call.on('close', () => {
          this.transports.delete(transport);
        });
        options.onTransport(transport);
      },
    };
    this.server.addService(ahpGrpcTransportServiceDefinition, implementation);
  }

  async listen(): Promise<void> {
    if (this.options.unlinkExisting ?? true) {
      await unlink(this.socketPath).catch(error => {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return;
        }
        throw error;
      });
    }
    const address = grpcUdsAddress(this.socketPath);
    await new Promise<void>((resolveListen, reject) => {
      this.server.bindAsync(address, ServerCredentials.createInsecure(), error => {
        if (error) {
          reject(error);
          return;
        }
        this.boundAddress = address;
        resolveListen();
      });
    });
  }

  close(): Promise<void> {
    for (const transport of this.transports) {
      transport.close();
    }
    return new Promise(resolveClose => {
      this.server.tryShutdown(() => {
        if (this.boundAddress) {
          void unlink(this.socketPath).catch(() => undefined);
        }
        resolveClose();
      });
    });
  }
}

export function createGrpcAhpClientTransport(options: AhpGrpcUdsClientTransportOptions): GrpcAhpClientTransport {
  return new GrpcAhpClientTransport(options);
}

export function createGrpcUdsServer(options: AhpGrpcUdsServerOptions): AhpGrpcUdsServer {
  return new AhpGrpcUdsServer(options);
}

export function grpcUdsAddress(socketPath: string): string {
  return `unix://${resolve(socketPath)}`;
}

function serializeFrame(frame: GrpcFrame): Buffer {
  return Buffer.from(JSON.stringify(frame), 'utf8');
}

function deserializeFrame(bytes: Buffer): GrpcFrame {
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed.text !== 'string') {
    throw new Error('invalid AHP gRPC frame');
  }
  return { text: parsed.text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
