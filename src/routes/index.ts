// Importing each module registers its routes into the shared registry.
import { routes, type Route } from './registry.ts';
import './auth.ts';
import './discovery.ts';
import './social.ts';
import './content.ts';
import './pro.ts';
import './ai.ts';
import './admin.ts';

export type { Route, ReqCtx } from './registry.ts';
export function registerRoutes(): Route[] { return routes; }
