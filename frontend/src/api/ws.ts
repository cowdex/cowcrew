import { MOCK, loadMock } from './client';
import type { WsMessage } from './types';

type Listener = (m: WsMessage) => void;
const listeners = new Set<Listener>();

export function onWs(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function dispatchWs(m: WsMessage) {
  listeners.forEach((l) => {
    try {
      l(m);
    } catch (e) {
      console.error(e);
    }
  });
}

type ReconnectListener = () => void;
const reconnectListeners = new Set<ReconnectListener>();

/**
 * Called after the socket comes back from a drop. Messages sent while it was down are lost,
 * so every subscriber should refetch its data from REST here.
 */
export function onReconnect(fn: ReconnectListener): () => void {
  reconnectListeners.add(fn);
  return () => {
    reconnectListeners.delete(fn);
  };
}

function dispatchReconnect() {
  reconnectListeners.forEach((l) => {
    try {
      l();
    } catch (e) {
      console.error(e);
    }
  });
}

/** Opens /ws with auto-reconnect (exponential backoff, max 10 s). Returns a stop function. */
export function startWs(onConnected: (ok: boolean) => void): () => void {
  if (MOCK) {
    let stop: (() => void) | null = null;
    let cancelled = false;
    loadMock().then((m) => {
      if (cancelled) return;
      stop = m.startMockStream(dispatchWs);
      onConnected(true);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  let ws: WebSocket | null = null;
  let retry = 0;
  let timer: number | undefined;
  let closed = false;
  let everOpened = false;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      onConnected(true);
      if (everOpened) dispatchReconnect();
      everOpened = true;
    };
    ws.onmessage = (ev) => {
      try {
        dispatchWs(JSON.parse(String(ev.data)) as WsMessage);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      onConnected(false);
      if (closed) return;
      const delay = Math.min(10000, 500 * 2 ** retry++);
      timer = window.setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}
