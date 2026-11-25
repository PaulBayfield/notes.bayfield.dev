// The part of @hocuspocus/server 1.1 the collaboration server uses. The package ships types, but with
// extensionless relative imports that NodeNext resolution can't follow.

declare module "@hocuspocus/server" {
  import type { IncomingMessage, IncomingHttpHeaders } from "node:http";
  import type { Doc } from "yjs";

  export class Document extends Doc {
    name: string;
  }

  export interface ConnectionConfiguration {
    readOnly: boolean;
    requiresAuthentication: boolean;
    isAuthenticated: boolean;
  }

  interface Base {
    documentName: string;
    requestHeaders: IncomingHttpHeaders;
    requestParameters: URLSearchParams;
    socketId: string;
  }

  export interface Configuration {
    quiet: boolean;
    debounce: number;
    maxDebounce: number;
    timeout: number;
    onAuthenticate(data: Base & { token: string; connection: ConnectionConfiguration }): Promise<unknown>;
    onLoadDocument(data: Base & { document: Document; context: any; connection: ConnectionConfiguration }): Promise<unknown>;
    connected(data: Base & { context: any; connection: ConnectionConfiguration }): Promise<unknown>;
    onChange(data: Base & { document: Document; context: any; update: Uint8Array; clientsCount: number }): Promise<unknown>;
    onStoreDocument(data: Base & { document: Document; context: any; clientsCount: number }): Promise<unknown>;
  }

  export interface Hocuspocus {
    documents: Map<string, Document>;
    configure(configuration: Partial<Configuration>): Hocuspocus;
    handleConnection(incoming: unknown, request: IncomingMessage, documentName: string, context?: unknown): void;
    closeConnections(documentName?: string): void;
  }

  export const Server: Hocuspocus;
}
