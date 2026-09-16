"use client";

import type { Serialized } from "./serialize";
import type { OfframpOrder, OnrampOrder } from "@/db/schema";

export type OnrampDto = Serialized<OnrampOrder>;
export type OfframpDto = Serialized<OfframpOrder>;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText, body);
  return body as T;
}
