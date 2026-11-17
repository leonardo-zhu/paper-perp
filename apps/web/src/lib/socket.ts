import { type ClientMessage, HEARTBEAT_INTERVAL_MS, type ServerMessage } from '@paperperp/shared';

export type SocketState = 'connecting' | 'open' | 'closed';

const PING_EVERY_MS = 5_000;
/** No message at all for this long → the connection is dead even if TCP says otherwise. */
const SILENCE_TIMEOUT_MS = Math.min(HEARTBEAT_INTERVAL_MS, 12_000);
const MAX_BACKOFF_MS = 15_000;

/**
 * Browser WebSocket with:
 *  - exponential backoff + jitter, reset after a successful open
 *  - app-level ping/pong for RTT and a silence watchdog
 *  - immediate reconnect when the browser comes back online / tab becomes visible
 * Subscriptions are owned by the caller (re-sent in `onOpen`).
 */
export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private lastMessageAt = 0;
  private stopped = true;
  state: SocketState = 'closed';
  rttMs: number | null = null;

  constructor(
    private readonly url: () => string,
    private readonly handlers: {
      onMessage(msg: ServerMessage): void;
      onOpen(): void;
      onState(state: SocketState, rttMs: number | null): void;
    },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Reconnect now (e.g. after sign-in, so the upgrade carries the new cookie). */
  restart(): void {
    if (this.stopped) return;
    this.attempt = 0;
    const old = this.ws;
    this.ws = null;
    old?.close();
    clearTimeout(this.retryTimer);
    this.connect();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private kick = () => {
    if (this.state !== 'open') this.restart();
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.kick();
  };

  private setState(state: SocketState) {
    this.state = state;
    this.handlers.onState(state, this.rttMs);
  }

  private connect(): void {
    this.setState('connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.setState('open');
      this.handlers.onOpen();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.heartbeat(ws), PING_EVERY_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      const msg = JSON.parse(ev.data as string) as ServerMessage;
      if (msg.type === 'pong') {
        this.rttMs = Date.now() - msg.ts;
        this.handlers.onState(this.state, this.rttMs);
        return;
      }
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.setState('closed');
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private heartbeat(ws: WebSocket): void {
    if (Date.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
      ws.close();
      return;
    }
    this.send({ op: 'ping', ts: Date.now() });
  }

  private scheduleReconnect(): void {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt++;
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }
}
