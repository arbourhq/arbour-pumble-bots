import type { PumbleClient } from "./pumble.js";

export function listen(
  client: PumbleClient,
  name: string,
  receive: (payload: unknown) => void,
  signal: AbortSignal,
): void {
  let retry: NodeJS.Timeout | undefined;
  let disconnect: (() => void) | undefined;
  let delay = 2_000;

  function reconnect(): void {
    if (signal.aborted) return;
    console.error(`${name} lost the Pumble connection. Reconnecting.`);
    retry = setTimeout(() => {
      void connect();
    }, delay);
    delay = Math.min(60_000, delay * 2);
  }

  async function connect(): Promise<void> {
    try {
      const url = await client.connectUrl();
      if (signal.aborted) return;

      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      let lastMessage = Date.now();
      let closed = false;
      const heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 60_000) {
          close();
        } else if (socket.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, 25_000);

      function close(): void {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        socket.close();
        disconnect = undefined;
        reconnect();
      }

      disconnect = close;
      socket.addEventListener("open", () => {
        if (closed) return;
        lastMessage = Date.now();
        delay = 2_000;
        console.log(`${name} connected to Pumble`);
      });
      socket.addEventListener("close", close);
      socket.addEventListener("error", close);
      socket.addEventListener("message", (event) => {
        if (closed) return;
        lastMessage = Date.now();
        const data: unknown = event.data;
        const text = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data;
        if (typeof text !== "string" || text === "pong") return;
        try {
          const message: { payload?: unknown } | null = JSON.parse(text);
          receive(message?.payload);
        } catch {
          console.error(`${name} could not process a Pumble event`);
        }
      });
    } catch {
      reconnect();
    }
  }

  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(retry);
      disconnect?.();
    },
    { once: true },
  );
  void connect();
}
