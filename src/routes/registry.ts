import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../lib/auth.ts';

export interface ReqCtx {
  req: IncomingMessage; res: ServerResponse; ctx: Ctx;
  params: Record<string, string>; query: URLSearchParams; url: URL;
}
export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  status?: number;
  handler: (c: ReqCtx) => Promise<any> | any;
}

export const routes: Route[] = [];
export const route = (method: Route['method'], path: string, handler: Route['handler'], status?: number) =>
  routes.push({ method, path, handler, status });
