import { createRequire } from "node:module";
import { mkdirSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AugError } from "@aug/core";
import { validateStoredInvocation } from "./invocation-store.js";
import type { InvocationReceipt, InvocationStore, StoredInvocation } from "./invocation-store.js";

const applicationId = 0x41554731;
type Row = { id: string; revision: number; state: string; keep_until: number | null; payload: string };

/** Encrypted, single-owner SQLite reference adapter. No automatic replay after a crash. */
export class SqliteInvocationStore implements InvocationStore {
  readonly durable = true;
  private readonly db: DatabaseSync;
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;
  private claimed = false;
  private closed = false;

  constructor(options: { path: string; key: Uint8Array }) {
    if (!options.path || options.path === ":memory:" || options.key.length !== 32) {
      throw new AugError("INVALID_STATE_CONFIG", "Persistent state requires a database path and 32-byte key");
    }
    this.encryptionKey = Buffer.from(hkdfSync("sha256", options.key, "aug-state-v1", "payload", 32));
    this.indexKey = Buffer.from(hkdfSync("sha256", options.key, "aug-state-v1", "index", 32));
    const file = resolve(options.path);
    let database: DatabaseSync | undefined;
    try {
      const existing = existsSync(file);
      if (existing && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      database = new Database(file, { allowExtension: false });
      const identity = database.prepare("PRAGMA application_id").get()?.application_id;
      if (existing && identity !== applicationId) throw new AugError("STATE_STORE_INVALID", "File is not an AUG invocation store", 503);
      // EXCLUSIVE mode retains the OS lock between commits; closing/crashing releases ownership.
      database.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (!existing) {
        database.exec(`BEGIN IMMEDIATE;
          PRAGMA application_id=${applicationId};
          CREATE TABLE aug_meta (version INTEGER NOT NULL, key_check TEXT NOT NULL);
          CREATE TABLE aug_requests (request_key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL) STRICT;
          CREATE TABLE aug_records (id TEXT PRIMARY KEY REFERENCES aug_requests(id), revision INTEGER NOT NULL,
            state TEXT NOT NULL, keep_until INTEGER, payload TEXT NOT NULL) STRICT;`);
        database.prepare("INSERT INTO aug_meta VALUES (1, ?)").run(this.digest("key-check-v1"));
        database.exec("COMMIT;");
      }
      const meta = database.prepare("SELECT version, key_check FROM aug_meta").get();
      const expected = Buffer.from(this.digest("key-check-v1"));
      const actual = Buffer.from(typeof meta?.key_check === "string" ? meta.key_check : "");
      if (meta?.version !== 1 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new AugError("STATE_STORE_KEY_MISMATCH", "Invocation store key or format does not match", 503);
      }
      this.db = database;
      this.all(); // Authenticate and validate retained records before accepting any operation.
    } catch (error) {
      try { database?.close(); } catch { /* no raw filesystem/SQLite details */ }
      this.encryptionKey.fill(0); this.indexKey.fill(0);
      if (error instanceof AugError) throw error;
      throw new AugError("STATE_STORE_UNAVAILABLE", "Invocation store could not be opened or is already owned", 503);
    }
  }

  claim(): void {
    this.check();
    if (this.claimed) throw new AugError("STATE_STORE_IN_USE", "Invocation store already has a broker owner", 503);
    this.claimed = true;
  }

  private check(): void { if (this.closed) throw new AugError("STATE_STORE_UNAVAILABLE", "Invocation store is closed", 503); }
  private digest(value: string): string { return createHmac("sha256", this.indexKey).update(value).digest("hex"); }
  private aad(row: Omit<Row, "payload">): string { return JSON.stringify(["record-v1", row.id, row.revision, row.state, row.keep_until]); }
  private seal(value: unknown, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return JSON.stringify([iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")]);
  }
  private unseal(payload: string, aad: string): unknown {
    try {
      const [iv, tag, ciphertext] = JSON.parse(payload) as string[];
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8"));
    } catch { throw new AugError("STATE_STORE_INVALID", "Stored invocation authentication failed", 503); }
  }
  private decode(row: Row): StoredInvocation {
    const record = validateStoredInvocation(this.unseal(row.payload, this.aad(row)));
    if (record.invocation.id !== row.id || record.invocation.state !== row.state ||
      record.invocation.revision !== row.revision || record.keepUntil !== row.keep_until) throw new AugError("STATE_STORE_INVALID", "Stored invocation metadata does not match", 503);
    return record;
  }
  private transaction(action: () => void): void {
    this.check();
    try { this.db.exec("BEGIN IMMEDIATE"); action(); this.db.exec("COMMIT"); }
    catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve safe error */ }
      if (error instanceof AugError) throw error;
      throw new AugError("STATE_STORE_UNAVAILABLE", "Invocation state could not be committed", 503);
    }
  }
  all(): StoredInvocation[] {
    this.check();
    return (this.db.prepare("SELECT * FROM aug_records").all() as unknown as Row[]).map((row) => {
      const record = this.decode(row), receipt = this.lookup(record.key);
      if (receipt?.invocationId !== row.id || receipt.fingerprint !== record.fingerprint || receipt.contractHash !== record.contractHash) {
        throw new AugError("STATE_STORE_INVALID", "Stored invocation receipt does not match its record", 503);
      }
      return record;
    });
  }
  get(id: string): StoredInvocation | undefined {
    this.check(); const row = this.db.prepare("SELECT * FROM aug_records WHERE id=?").get(id) as unknown as Row | undefined;
    return row ? this.decode(row) : undefined;
  }
  lookup(key: string): InvocationReceipt | undefined {
    this.check(); const index = this.digest(key);
    const row = this.db.prepare("SELECT id, payload FROM aug_requests WHERE request_key=?").get(index);
    if (!row) return undefined;
    const receipt = this.unseal(String(row.payload), JSON.stringify(["request-v1", index, row.id])) as InvocationReceipt;
    if (receipt?.invocationId !== row.id || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !/^[a-f0-9]{64}$/.test(receipt.contractHash)) {
      throw new AugError("STATE_STORE_INVALID", "Stored invocation receipt is invalid", 503);
    }
    return receipt;
  }
  insert(record: StoredInvocation): void {
    validateStoredInvocation(record);
    const id = record.invocation.id, index = this.digest(record.key);
    const receipt: InvocationReceipt = { invocationId: id, fingerprint: record.fingerprint, contractHash: record.contractHash };
    const row = { id, revision: record.invocation.revision, state: record.invocation.state, keep_until: record.keepUntil };
    this.transaction(() => {
      this.db.prepare("INSERT INTO aug_requests VALUES (?, ?, ?)").run(index, id, this.seal(receipt, JSON.stringify(["request-v1", index, id])));
      this.db.prepare("INSERT INTO aug_records VALUES (?, ?, ?, ?, ?)").run(id, row.revision, row.state, row.keep_until, this.seal(record, this.aad(row)));
    });
  }
  replace(record: StoredInvocation, expectedRevision: number): void {
    validateStoredInvocation(record);
    const row = { id: record.invocation.id, revision: record.invocation.revision, state: record.invocation.state, keep_until: record.keepUntil };
    this.transaction(() => {
      const change = this.db.prepare("UPDATE aug_records SET revision=?,state=?,keep_until=?,payload=? WHERE id=? AND revision=?")
        .run(row.revision, row.state, row.keep_until, this.seal(record, this.aad(row)), row.id, expectedRevision);
      if (change.changes !== 1) throw new AugError("STATE_CONFLICT", "Invocation state has changed", 409);
    });
  }
  retire(record: StoredInvocation): void {
    // Durable encrypted request receipts intentionally outlive private input/output payloads.
    this.transaction(() => {
      const change = this.db.prepare("DELETE FROM aug_records WHERE id=? AND revision=?").run(record.invocation.id, record.invocation.revision);
      if (change.changes !== 1) throw new AugError("STATE_CONFLICT", "Invocation state has changed", 409);
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.encryptionKey.fill(0); this.indexKey.fill(0); }
  }
}
