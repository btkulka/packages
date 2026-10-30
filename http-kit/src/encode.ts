// Encoding without Buffer or btoa, so it behaves the same in Node and browsers.

/** UTF-8 safe base64. */
export function base64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (a << 16) | (b << 8) | c;
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? abc[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? abc[n & 63]! : "=";
  }
  return out;
}

/** The Authorization header value for HTTP Basic auth: `Basic base64(user:password)`. */
export function basicAuth(user: string, password: string): string {
  return `Basic ${base64(`${user}:${password}`)}`;
}

export type FormValue = string | number | boolean | null | undefined;
/** A field may repeat: give an array. null and undefined are left out. */
export type FormFields = Record<string, FormValue | readonly FormValue[]>;

/** application/x-www-form-urlencoded, for a POST body or a query string. */
export function formEncode(fields: FormFields): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    const list: readonly FormValue[] = isList(value) ? value : [value];
    for (const v of list) if (v !== undefined && v !== null) params.append(key, String(v));
  }
  return params.toString();
}

/** `url` with `query` appended (after `?`, or `&` when it already has a query). Empty values are left out. */
export function withQuery(url: string, query?: FormFields): string {
  if (!query) return url;
  const qs = formEncode(query);
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

function isList(v: FormValue | readonly FormValue[]): v is readonly FormValue[] {
  return Array.isArray(v);
}
