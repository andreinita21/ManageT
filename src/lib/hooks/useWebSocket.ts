"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { ClientMessage, ServerMessage } from "@/types";

interface UseWebSocketOptions {
  url: string;
  onMessage?: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxRetries?: number;
}

interface UseWebSocketReturn {
  send: (msg: ClientMessage) => void;
  connected: boolean;
  reconnecting: boolean;
  error: string | null;
}

export function useWebSocket({
  url,
  onMessage,
  onOpen,
  onClose,
  reconnect = true,
  reconnectInterval = 2000,
  maxRetries = 10,
}: UseWebSocketOptions): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onMessageRef.current = onMessage;
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        setError(null);
        retriesRef.current = 0;
        onOpenRef.current?.();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          onMessageRef.current?.(msg);
        } catch {
          console.error("Failed to parse WebSocket message");
        }
      };

      ws.onclose = () => {
        setConnected(false);
        onCloseRef.current?.();
        wsRef.current = null;

        if (reconnect && retriesRef.current < maxRetries) {
          setReconnecting(true);
          retriesRef.current += 1;
          const delay = reconnectInterval * Math.min(retriesRef.current, 5);
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else if (retriesRef.current >= maxRetries) {
          setReconnecting(false);
          setError("Max reconnection attempts reached");
        }
      };

      ws.onerror = () => {
        setError("WebSocket connection error");
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    }
  }, [url, reconnect, reconnectInterval, maxRetries]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send, connected, reconnecting, error };
}
