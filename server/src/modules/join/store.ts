import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The files of the join codes (docs/join-code.md) in JOIN_DIR. The `.join` file holds the seed - the one place a code can be
 * shown from - so every file is written 0600 in a 0700 directory, atomically (written next to the target, then renamed).
 * Nothing in here logs; callers must not put file contents into a message either.
 */

export type CodeName = "public" | `invite-${string}`;

export interface CodeMetadata {
  v: 1;
  clientId: string;
  node: string;
  createdAt: string;
  status: "active" | "grace" | "revoked";
  useCount: number;
  rootFingerprint: string | null;
  /** Invitation codes only. */
  label?: string | null;
  expiresAt?: string | null;
  maxUses?: number | null;
}

export class JoinStore {
  constructor(readonly dir: string) {}

  path(name: CodeName, ext: "join" | "svg" | "json"): string {
    return join(this.dir, `${name}.${ext}`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // a volume or a mount we do not own: the files themselves are still 0600
    }
  }

  private writeAtomic(file: string, content: string): void {
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, content, { mode: 0o600 });
      chmodSync(temp, 0o600); // the umask may have narrowed it, never widened; this makes it exact
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  writeCode(name: CodeName, uri: string, svg: string, meta: CodeMetadata): void {
    this.ensureDir();
    this.writeAtomic(this.path(name, "join"), `${uri}\n`);
    this.writeAtomic(this.path(name, "svg"), svg);
    this.writeMetadata(name, meta);
  }

  writeMetadata(name: CodeName, meta: CodeMetadata): void {
    this.ensureDir();
    this.writeAtomic(this.path(name, "json"), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** The code line of a name, or null when there is no such file. */
  readCode(name: CodeName): string | null {
    const file = this.path(name, "join");
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8").trim();
  }

  has(name: CodeName): boolean {
    return existsSync(this.path(name, "join"));
  }
}
