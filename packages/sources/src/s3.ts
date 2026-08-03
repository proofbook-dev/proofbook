import { createHash, createHmac } from "node:crypto";
import {
  requireEnv,
  SourceError,
  type AdapterContext,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

/**
 * S3-compatible object storage: AWS S3, Cloudflare R2, GCS in interop
 * mode, MinIO. Objects are OTLP JSON or JSONL files as written by the
 * OTel collector file exporter and archived with any uploader.
 *
 * Signing is a minimal AWS Signature v4 implementation for GET
 * requests: two calls (ListObjectsV2, GetObject), no SDK, nothing to
 * audit beyond this file. Objects are selected by prefix and by
 * LastModified inside the window, padded a day each side because
 * archive timestamps lag span timestamps; the normaliser applies the
 * precise window to the spans themselves.
 */

interface S3Config {
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Sign a GET request; returns headers. */
export function signV4(
  cfg: S3Config,
  path: string,
  query: string,
  nowISO: string,
): Record<string, string> {
  const amzDate = nowISO.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const date = amzDate.slice(0, 8);
  const host = new URL(cfg.endpoint).host;
  const payloadHash = sha256("");
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = `GET\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
  const kDate = hmac(`AWS4${cfg.secretKey}`, date);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, toSign).toString("hex");
  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]!);
}

export const s3: SourceAdapter = {
  name: "s3",
  description: "OTLP archives in S3-compatible object storage (S3, R2, GCS interop, MinIO)",
  requiredEnv: ["S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
  optionalEnv: [
    "S3_ENDPOINT (default https://s3.amazonaws.com)",
    "S3_REGION (default us-east-1)",
    "S3_PREFIX (default traces/)",
  ],

  async fetch(ctx: AdapterContext): Promise<SourceFile[]> {
    const env = requireEnv(this, ctx.env);
    const cfg: S3Config = {
      bucket: env.S3_BUCKET!,
      endpoint: (ctx.env.S3_ENDPOINT ?? "https://s3.amazonaws.com").replace(/\/$/, ""),
      region: ctx.env.S3_REGION ?? "us-east-1",
      accessKey: env.AWS_ACCESS_KEY_ID!,
      secretKey: env.AWS_SECRET_ACCESS_KEY!,
      prefix: ctx.env.S3_PREFIX ?? "traces/",
    };
    const nowISO = new Date().toISOString();
    const pad = 24 * 3600 * 1000;
    const from = new Date(ctx.window.fromISO).getTime() - pad;
    const to = new Date(ctx.window.toISO).getTime() + pad;

    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query = [
        `continuation-token=${encodeURIComponent(token ?? "")}`,
        "list-type=2",
        `prefix=${encodeURIComponent(cfg.prefix).replace(/%2F/g, "%2F")}`,
      ]
        .filter((q) => !q.startsWith("continuation-token=") || token)
        .sort()
        .join("&");
      const path = `/${cfg.bucket}`;
      const res = await ctx.fetchImpl(`${cfg.endpoint}${path}?${query}`, {
        headers: signV4(cfg, path, query, nowISO),
      });
      if (!res.ok) {
        throw new SourceError(
          `Object storage listing failed (${res.status}). Check bucket, region, endpoint and key scope (read-only is enough).`,
        );
      }
      const xml = await res.text();
      const listKeys = xmlValues(xml, "Key");
      const modified = xmlValues(xml, "LastModified");
      listKeys.forEach((key, i) => {
        const at = modified[i] ? new Date(modified[i]!).getTime() : from;
        if (/\.jsonl?$/.test(key) && at >= from && at <= to) keys.push(key);
      });
      token = xmlValues(xml, "NextContinuationToken")[0];
    } while (token);
    ctx.log(`s3: ${keys.length} archive objects in window`);

    const files: SourceFile[] = [];
    for (const key of keys) {
      const path = `/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
      const res = await ctx.fetchImpl(`${cfg.endpoint}${path}`, {
        headers: signV4(cfg, path, "", nowISO),
      });
      if (!res.ok) continue;
      files.push({ name: key.split("/").at(-1)!, content: await res.text() });
    }
    return files;
  },
};
