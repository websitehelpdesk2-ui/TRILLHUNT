/**
 * Minimal ambient declarations for the Node surface THRILLHUNT actually uses.
 *
 * Installing @types/node would also work, but this project deliberately has no
 * dependencies — `node src/server.ts` runs it as-is, no npm install, no build
 * step. Declaring just what we touch keeps that promise while giving the editor
 * enough to stop reporting phantom errors.
 *
 * These are intentionally loose. They exist to make the editor useful, not to
 * prove anything: nothing type-checks at runtime, because Node strips types
 * rather than compiling them. If this file grows past a screenful, that is the
 * signal to add @types/node as a devDependency and delete it.
 */

// ---------------------------------------------------------------- globals

// Buffer genuinely is used as a Uint8Array throughout this codebase (passed to
// crypto functions, concatenated with Uint8Array[], etc.), so it extends it
// directly. The one incompatibility TS flags here (Uint8Array.buffer typed as
// ArrayBufferLike vs ArrayBuffer) only appears when the "DOM" lib is loaded —
// this is a server that never runs in a browser, so DOM has no reason to be
// in tsconfig's lib list in the first place. Removing it there is the fix;
// this interface stays a plain extension.
interface Buffer extends Uint8Array {
  toString(encoding?: string, start?: number, end?: number): string;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
  equals(other: Uint8Array): boolean;
  indexOf(value: any, byteOffset?: number, encoding?: string): number;
  includes(value: any, byteOffset?: number, encoding?: string): boolean;
  readUInt16BE(offset?: number): number;
  readUInt16LE(offset?: number): number;
  readUInt32BE(offset?: number): number;
  readUInt32LE(offset?: number): number;
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  write(string: string, offset?: number, length?: number, encoding?: string): number;
}

declare const Buffer: {
  new (size: number): Buffer;
  from(input: any, encoding?: string): Buffer;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  alloc(size: number, fill?: any, encoding?: string): Buffer;
  allocUnsafe(size: number): Buffer;
  isBuffer(obj: any): boolean;
  byteLength(input: any, encoding?: string): number;
};

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
  cwd(): string;
  platform: string;
  version: string;
  execPath: string;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  memoryUsage(): { rss: number; heapTotal: number; heapUsed: number };
};

declare const __dirname: string;
declare const __filename: string;

// ---------------------------------------------------------------- node:http

declare module 'node:http' {
  export interface IncomingMessage extends AsyncIterable<Buffer> {
    url?: string;
    method?: string;
    // `cookie` and `set-cookie` are the only headers we treat specially:
    // cookie is always a single value, set-cookie is always a list.
    headers: Record<string, string | undefined> & { 'set-cookie'?: string[] };
    socket: { remoteAddress?: string; writable: boolean; end(data?: string): void };
    readableEnded: boolean;
    on(event: string, listener: (...args: any[]) => void): this;
    pause(): this;
    resume(): this;
    destroy(error?: Error): this;
  }

  export interface ServerResponse {
    statusCode: number;
    writableEnded: boolean;
    setHeader(name: string, value: string | number | readonly string[]): this;
    getHeader(name: string): string | number | string[] | undefined;
    writeHead(status: number, headers?: Record<string, any>): this;
    write(chunk: any): boolean;
    end(chunk?: any): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export interface Server {
    listen(port: number, host?: string, cb?: () => void): Server;
    on(event: string, listener: (...args: any[]) => void): Server;
    close(cb?: () => void): Server;
  }

  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): Server;
}

// -------------------------------------------------------------- node:crypto

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  export function randomInt(min: number, max?: number): number;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function scryptSync(password: string, salt: string | Buffer, keylen: number, options?: any): Buffer;
  export function createHash(algorithm: string): {
    update(data: any, encoding?: string): any;
    digest(encoding?: string): any;
  };
  export function createHmac(algorithm: string, key: string | Buffer): {
    update(data: any, encoding?: string): any;
    digest(encoding?: string): any;
  };
}

// ------------------------------------------------------------------ node:fs

declare module 'node:fs' {
  export function readFileSync(path: string, encoding?: any): any;
  export function writeFileSync(path: string, data: any, options?: { mode?: number; encoding?: string }): void;
  export function appendFileSync(path: string, data: any): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { size: number; isFile(): boolean; isDirectory(): boolean; mtimeMs: number };
  export function unlinkSync(path: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function createReadStream(path: string, options?: any): any;
}

// ---------------------------------------------------------------- node:path

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export function normalize(path: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}

// ----------------------------------------------------------------- node:url

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

// ------------------------------------------------------- node:child_process

declare module 'node:child_process' {
  export function spawn(command: string, args?: readonly string[], options?: any): {
    pid?: number;
    stdout: { on(event: string, listener: (chunk: any) => void): void };
    stderr: { on(event: string, listener: (chunk: any) => void): void };
    on(event: string, listener: (...args: any[]) => void): void;
    kill(signal?: string): boolean;
  };
  export function execSync(command: string, options?: any): Buffer | string;
}

// -------------------------------------------------------------- node:sqlite

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: any[]): any[];
      get(...params: any[]): any;
      run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}