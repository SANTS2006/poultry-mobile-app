import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/** Socket.IO hardened for an API-only, mobile-first service. */
export class SecureIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext, private readonly origins: string[]) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      path: '/realtime',
      transports: ['websocket'], // no long-polling fallback: smaller attack surface, native apps support WebSocket
      serveClient: false, // never serve the client bundle
      maxHttpBufferSize: 10_000, // 10 kB per message: clients only send tiny control messages
      connectTimeout: 10_000,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      cors: { origin: this.origins, methods: ['GET', 'POST'] }, // empty list ⇒ no browser origin allowed; native apps send no Origin
    } as ServerOptions);
  }
}
