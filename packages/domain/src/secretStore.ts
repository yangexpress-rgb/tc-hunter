import { hkdfSync, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { open as openSealed, seal } from "./crypto";

/**
 * Vault pattern (brief 2.4, 8). Employer-site passwords and saved site sessions
 * never enter the app database, logs, exports or any UI layer. The database
 * holds only an opaque vault_ref (site_account.vault_ref). Each applicant has
 * their own vault: Yong's store cannot be opened with Leo's id and vice versa.
 */
export type SecretKind = "site_password" | "site_session" | "email_token";

/** Wraps a secret so it cannot leak through logging, JSON or string conversion. */
export class SecretValue {
  #value: string;
  constructor(value: string) { this.#value = value; }
  /** The only way to read the secret. Call sites are reviewed: Phase 5 automation only. */
  reveal(): string { return this.#value; }
  toString(): string { return "[secret]"; }
  toJSON(): string { return "[secret]"; }
  [inspect.custom](): string { return "[secret]"; }
}

export interface SecretStore {
  /** Stores a secret in this applicant's vault and returns an opaque reference. */
  put(applicantId: string, kind: SecretKind, label: string, secret: SecretValue): Promise<string>;
  get(applicantId: string, vaultRef: string): Promise<SecretValue | null>;
  delete(applicantId: string, vaultRef: string): Promise<void>;
  /** Delete-my-data: removes the whole vault for one applicant. */
  destroyVault(applicantId: string): Promise<void>;
}

const REF = /^vault:[0-9a-f-]{36}$/;

/** In-memory store, for tests only. */
export class MemorySecretStore implements SecretStore {
  private vaults = new Map<string, Map<string, { kind: SecretKind; label: string; secret: string }>>();
  async put(applicantId: string, kind: SecretKind, label: string, secret: SecretValue): Promise<string> {
    const ref = `vault:${randomUUID()}`;
    const v = this.vaults.get(applicantId) ?? new Map();
    v.set(ref, { kind, label, secret: secret.reveal() });
    this.vaults.set(applicantId, v);
    return ref;
  }
  async get(applicantId: string, vaultRef: string): Promise<SecretValue | null> {
    const item = this.vaults.get(applicantId)?.get(vaultRef);
    return item ? new SecretValue(item.secret) : null;
  }
  async delete(applicantId: string, vaultRef: string): Promise<void> {
    this.vaults.get(applicantId)?.delete(vaultRef);
  }
  async destroyVault(applicantId: string): Promise<void> {
    this.vaults.delete(applicantId);
  }
}

/**
 * Household backend: one encrypted file per applicant on the vault volume,
 * which is separate from the database volume. The vault key (TC_VAULT_KEY) is a
 * different key from the database master key; each applicant's file key is
 * derived from it with their id, so one applicant's file cannot be opened as
 * the other's.
 */
export class FileSecretStore implements SecretStore {
  constructor(private dir: string, private vaultKey: Buffer) {
    if (vaultKey.length !== 32) throw new Error("vault key must be 32 bytes");
  }
  private keyFor(applicantId: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.vaultKey, Buffer.alloc(0), `tc-hunter-vault:${applicantId}`, 32));
  }
  private path(applicantId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(applicantId)) throw new Error("bad applicant id");
    return join(this.dir, `${applicantId}.vault`);
  }
  private async load(applicantId: string): Promise<Record<string, { kind: SecretKind; label: string; secret: string }>> {
    try {
      const raw = await readFile(this.path(applicantId));
      return JSON.parse(openSealed(this.keyFor(applicantId), raw, applicantId).toString("utf8"));
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("vault could not be opened");  // never include the cause: it may echo content
    }
  }
  private async save(applicantId: string, data: object): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path(applicantId)}.${randomUUID()}.tmp`;
    await writeFile(tmp, seal(this.keyFor(applicantId), JSON.stringify(data), applicantId), { mode: 0o600 });
    await rename(tmp, this.path(applicantId));
  }
  async put(applicantId: string, kind: SecretKind, label: string, secret: SecretValue): Promise<string> {
    const data = await this.load(applicantId);
    const ref = `vault:${randomUUID()}`;
    data[ref] = { kind, label, secret: secret.reveal() };
    await this.save(applicantId, data);
    return ref;
  }
  async get(applicantId: string, vaultRef: string): Promise<SecretValue | null> {
    if (!REF.test(vaultRef)) return null;
    const item = (await this.load(applicantId))[vaultRef];
    return item ? new SecretValue(item.secret) : null;
  }
  async delete(applicantId: string, vaultRef: string): Promise<void> {
    const data = await this.load(applicantId);
    delete data[vaultRef];
    await this.save(applicantId, data);
  }
  async destroyVault(applicantId: string): Promise<void> {
    await rm(this.path(applicantId), { force: true });
  }
}
