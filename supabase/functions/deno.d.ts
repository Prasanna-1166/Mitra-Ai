// Ambient type definitions for Supabase Edge Functions (Deno runtime)
// This file allows TypeScript in the IDE to recognize Deno globals and npm: specifiers.

declare namespace Deno {
  export interface ServeOptions {
    port?: number;
    hostname?: string;
    signal?: AbortSignal;
    onError?: (error: unknown) => Response | Promise<Response>;
    onListen?: (params: { hostname: string; port: number }) => void;
  }

  export function serve(handler: (req: Request) => Response | Promise<Response>): void;
  export function serve(options: ServeOptions, handler: (req: Request) => Response | Promise<Response>): void;

  export function upgradeWebSocket(req: Request): {
    socket: WebSocket;
    response: Response;
  };

  export const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    has(key: string): boolean;
    toObject(): Record<string, string>;
  };
}

declare module 'npm:@supabase/supabase-js@2' {
  export * from '@supabase/supabase-js';
}
