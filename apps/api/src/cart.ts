import type { FastifyRequest } from "fastify";

/** The cart id from the `cart` cookie (a UUID), or null. */
export function cartId(req: FastifyRequest): string | null {
  const m = /(?:^|;\s*)cart=([a-f0-9-]{36})/.exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}
