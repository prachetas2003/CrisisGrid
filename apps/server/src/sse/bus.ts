import type { FastifyReply } from "fastify";

/**
 * SSE event bus (plan/03-architecture.md §5).
 * One channel; every engine/agent event is fanned out to connected browsers.
 * M1 emits scenario.* events; agent.* / plan.* / action.* arrive in M2-M3.
 */

export interface SseEvent {
  type: string;
  payload: unknown;
}

const clients = new Set<FastifyReply>();

export function addClient(reply: FastifyReply): void {
  clients.add(reply);
  reply.raw.on("close", () => clients.delete(reply));
}

export function broadcast(event: SseEvent): void {
  // Default (unnamed) message frames so EventSource.onmessage receives every
  // event; the type travels inside the JSON payload.
  const frame = `data: ${JSON.stringify({ type: event.type, payload: event.payload })}\n\n`;
  for (const client of clients) {
    client.raw.write(frame);
  }
}

export function clientCount(): number {
  return clients.size;
}
