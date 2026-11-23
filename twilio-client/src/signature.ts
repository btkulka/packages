// Twilio's X-Twilio-Signature on the webhooks it sends: HMAC-SHA1, keyed with the Auth Token, of the
// full URL Twilio called followed by each POST parameter's name and value (names sorted), in base64.
// SHA-1 and HMAC are written out here rather than taken from node:crypto or Web Crypto, so the
// check stays synchronous and runs anywhere (a browser page without crypto.subtle included).

const utf8 = (s: string) => new TextEncoder().encode(s);

function sha1(msg: Uint8Array): Uint8Array {
  // The message, a 1 bit, zeros, and the length in bits as 64 bits big-endian: a whole number of 64-byte blocks.
  const total = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = msg.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(total - 4, bits >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const o = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => o.setUint32(i * 4, h));
  return out;
}

/** HMAC-SHA1 (RFC 2104). */
export function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha1(key) : key);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha1(inner), 64);
  return sha1(outer);
}

const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes as base64 (http-kit's `base64` takes text, not bytes). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ABC[(n >> 18) & 63]! + ABC[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? ABC[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? ABC[n & 63]! : "=";
  }
  return out;
}

/**
 * The X-Twilio-Signature Twilio sends with a webhook: `url` is the exact address Twilio called
 * (scheme, host, path and query), `params` the POST form fields (none for a GET).
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string> = {}): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return bytesToBase64(hmacSha1(utf8(authToken), utf8(data)));
}

/** True when `signature` (the X-Twilio-Signature header) is the one the Auth Token makes for this URL and these fields. Compared in constant time. */
export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const want = twilioSignature(authToken, url, params);
  if (want.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
