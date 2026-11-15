import type { SocketEvents, WebSocketLike } from '../lib/live/socket';
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closes: number[] = [];
  listeners: { [K in keyof SocketEvents]: Set<(event: SocketEvents[K]) => void> } = {
    open: new Set(), message: new Set(), close: new Set(), error: new Set()
  };
  addEventListener<K extends keyof SocketEvents>(type: K, listener: (e: SocketEvents[K]) => void) { this.listeners[type].add(listener); }
  removeEventListener<K extends keyof SocketEvents>(type: K, listener: (e: SocketEvents[K]) => void) { this.listeners[type].delete(listener); }
  emit<K extends keyof SocketEvents>(type: K, event: SocketEvents[K]) { for (const listener of this.listeners[type]) listener(event); }
  open() { this.readyState = 1; this.emit('open', {}); }
  message(data: unknown) { this.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  send(data: string) { if (this.readyState !== 1) throw new Error('Closed'); this.sent.push(data); }
  close(code = 1000) { this.closes.push(code); this.readyState = 3; this.emit('close', { code }); }
}
