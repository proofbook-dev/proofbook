import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...msgs) => sha512(ed.etc.concatBytes(...msgs));

/**
 * DSSE (Dead Simple Signing Envelope), the in-toto envelope format.
 * Signatures cover the PAE encoding, which binds the payload type, so a
 * signature over an attestation cannot be replayed as a signature over
 * something else of the same bytes.
 *
 *   PAE(type, body) = "DSSEv1" SP len(type) SP type SP len(body) SP body
 */

export interface Envelope {
  payload: string; // base64
  payloadType: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

export function pae(payloadType: string, payload: Uint8Array): Uint8Array {
  const header = `DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `;
  return Buffer.concat([Buffer.from(header, "utf8"), payload]);
}

export function signEnvelope(
  payload: Uint8Array,
  payloadType: string,
  privateKeyHex: string,
): Envelope {
  const priv = ed.etc.hexToBytes(privateKeyHex);
  const publicKey = ed.etc.bytesToHex(ed.getPublicKey(priv));
  const sig = ed.sign(pae(payloadType, payload), priv);
  return {
    payload: Buffer.from(payload).toString("base64"),
    payloadType,
    signatures: [{ keyid: publicKey, sig: Buffer.from(sig).toString("base64") }],
  };
}

export function verifyEnvelope(
  envelope: Envelope,
  publicKeyHex: string,
): { valid: boolean; payload: Uint8Array } {
  const payload = new Uint8Array(Buffer.from(envelope.payload, "base64"));
  const signature = envelope.signatures.find((s) => s.keyid === publicKeyHex) ?? envelope.signatures[0];
  if (!signature) return { valid: false, payload };
  const valid = ed.verify(
    new Uint8Array(Buffer.from(signature.sig, "base64")),
    pae(envelope.payloadType, payload),
    ed.etc.hexToBytes(publicKeyHex),
  );
  return { valid, payload };
}
