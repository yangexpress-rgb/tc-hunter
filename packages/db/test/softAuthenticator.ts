import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * A software passkey for tests: produces real WebAuthn registration and
 * sign-in responses (ES256, "none" attestation), so the server's verification
 * code runs exactly as it does with a phone or laptop.
 */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("unsupported");
}

const b64u = (b: Buffer) => b.toString("base64url");

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private key: KeyObject;
  private pub: KeyObject;
  private counter = 0;
  constructor(private origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey; this.pub = publicKey;
  }
  private rpIdHash() { return createHash("sha256").update(new URL(this.origin).hostname).digest(); }
  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  register(challenge: string) {
    const jwk = this.pub.export({ format: "jwk" });
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credentialId, cose]);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: "public-key" as const, clientExtensionResults: {},
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", challenge)), attestationObject: b64u(attestationObject), transports: ["internal" as const] },
    };
  }

  signIn(challenge: string, origin = this.origin) {
    this.counter++;
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([0x05]), cnt]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]), this.key);
    return {
      id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: "public-key" as const, clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}
