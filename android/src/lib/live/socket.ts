export interface SocketEvents {
  open: object; message: { data: unknown }; close: { code: number }; error: object;
}
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener<K extends keyof SocketEvents>(type: K, listener: (event: SocketEvents[K]) => void): void;
  removeEventListener<K extends keyof SocketEvents>(type: K, listener: (event: SocketEvents[K]) => void): void;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;
// RN 0.88 WebSocket.js accepts a third options argument; DOM declarations omit it.
// Keep the native constructor adaptation here, never put credentials in a URL.
export const nativeSocket: SocketFactory = (url, headers) => {
  const Constructor = WebSocket as unknown as new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => WebSocketLike;
  return new Constructor(url, undefined, { headers });
};
