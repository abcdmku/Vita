// Minimal ambient declaration of the Deno global surface used by the on-device entrypoint (P1-030).
//
// WHY THIS EXISTS - it keeps the diff os-only while restoring typecheck coverage of main.ts in the
// repo-wide Node `tsc` lane, WITHOUT ever being visible to Deno's own checker:
//   - On-device, main.ts runs under the REAL pinned Deno runtime (/usr/lib/vita/deno). `deno check`
//     (config at os/x86_64/deno.json, outside this overlay) is the AUTHORITATIVE typecheck, vs Deno's
//     real lib - that is the check that matters and it is wired as this overlay's acceptance command.
//     This file is NOT referenced from main.ts (no triple-slash) and is `exclude`d in deno.json, so
//     `deno check` NEVER loads it. Deno therefore sees only its own `Deno` global - there is no
//     second `Deno.version` / duplicate-ambient-const declaration for Deno to reject (the round-2
//     blocking risk). The shim lives in the Deno lane's source tree but is inert to Deno.
//   - The repo-wide Node `tsc` lane (root tsconfig.json: include "os/**/*.ts") ALSO compiles main.ts.
//     Node has no `Deno` global, so without this declaration the Node lane fails on the `Deno.*`
//     references in main.ts. Round 1 fixed that by EXCLUDING the overlay from the Node lane via a root
//     tsconfig edit - but that (a) edited a root file (scope) and (b) dropped the entrypoint from the
//     Node lane entirely (coverage). This file fixes both with an os-local change: the include glob
//     "os/**/*.ts" matches this sibling `.d.ts` automatically, so the Node lane picks up the ambient
//     `Deno` namespace and keeps the entrypoint IN its coverage - no triple-slash, no root edit.
//
// MINIMAL ON PURPOSE - it declares only the members main.ts uses, so it cannot mask a typo on
// some other Deno API in the Node lane; and any such use is caught authoritatively by `deno check`
// against Deno's real lib. Keep in sync: if main.ts starts using another Deno API, add its (subset,
// exact) signature here so the Node lane keeps compiling.

declare namespace Deno {
  /** Process/runtime version triplet. Only `deno` is read here. */
  const version: {
    readonly deno: string;
  };

  interface UnixConnectOptions {
    readonly transport: "unix";
    readonly path: string;
  }

  interface TcpConnectOptions {
    readonly transport: "tcp";
    readonly hostname: string;
    readonly port: number;
  }

  interface UnixListenOptions {
    readonly transport: "unix";
    readonly path: string;
  }

  interface Conn {
    read(p: Uint8Array): Promise<number | null>;
    write(p: Uint8Array): Promise<number>;
    close(): void;
  }

  interface Listener extends AsyncIterable<Conn> {
    accept(): Promise<Conn>;
    close(): void;
  }

  interface TcpListenOptions {
    readonly transport: "tcp";
    readonly hostname: string;
    readonly port: number;
  }

  const env: {
    get(key: string): string | undefined;
  };

  namespace errors {
    class NotFound extends Error {}
  }

  /** Open a Unix domain socket connection. */
  function connect(options: UnixConnectOptions): Promise<Conn>;

  /** Open a TCP connection. */
  function connect(options: TcpConnectOptions): Promise<Conn>;

  /** Open a TCP listener. */
  function listen(options: TcpListenOptions): Listener;

  /** Open a Unix domain socket listener. */
  function listen(options: UnixListenOptions): Listener;

  /** Change mode bits on a filesystem path. */
  function chmod(path: string | URL, mode: number): Promise<void>;

  /** Remove a filesystem path. */
  function remove(path: string | URL): Promise<void>;

  /** Synchronously write text to a file, optionally appending. Subset of Deno's WriteFileOptions. */
  function writeTextFileSync(
    path: string | URL,
    data: string,
    options?: { append?: boolean },
  ): void;

  /** Read a UTF-8 text file. */
  function readTextFile(path: string | URL): Promise<string>;

  /** Terminate the process with the given exit code. */
  function exit(code?: number): never;
}
