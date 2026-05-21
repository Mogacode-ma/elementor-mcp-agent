import { randomBytes } from "node:crypto";

interface PendingConfirmation {
  token: string;
  intent: string;
  payload: unknown;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirmation>();

export function issueConfirmation(intent: string, payload: unknown, ttlSeconds: number): string {
  const token = randomBytes(8).toString("hex");
  pending.set(token, {
    token,
    intent,
    payload,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  return token;
}

export function consumeConfirmation(
  token: string,
  expectedIntent: string,
): PendingConfirmation | null {
  const c = pending.get(token);
  if (!c) return null;
  pending.delete(token);
  if (c.expiresAt < Date.now()) return null;
  if (c.intent !== expectedIntent) return null;
  return c;
}

export function _clearAllConfirmations(): void {
  pending.clear();
}
