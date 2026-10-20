/**
 * API client.
 *
 * Cookies are the only credential: `credentials: 'include'` on every call and
 * no token stored in `localStorage` (Part A / A4.10).
 */

import type { ApiErrorBody } from '@shipcheck/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string[]>;
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'INTERNAL_ERROR';
    this.fields = body?.error?.fields ?? {};
    this.requestId = body?.error?.requestId ?? null;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

const BASE = '/api/v1';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload as ApiErrorBody, `Request failed (${response.status})`);
  }
  return payload as T;
}

/** Triggers a browser download for an authenticated endpoint. */
export async function apiDownload(
  path: string,
  fallbackName: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<void> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    let payload: ApiErrorBody | null = null;
    try {
      payload = JSON.parse(text) as ApiErrorBody;
    } catch {
      payload = null;
    }
    throw new ApiError(response.status, payload, `Download failed (${response.status})`);
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = match?.[1] ?? fallbackName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T,>(path: string, signal?: AbortSignal) => apiFetch<T>(path, { ...(signal ? { signal } : {}) }),
  post: <T,>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body }),
  patch: <T,>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  put: <T,>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  del: <T,>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};