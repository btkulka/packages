import type { ModelSource } from "./load.js";

/**
 * A source that fetches: the model at `url`, and a file beside it at `besideUrl(rel)` (by default the
 * model's own folder in the same URL space). For an app protocol (gallery://file/12) whose neighbours live
 * at another address, pass besideUrl.
 */
export function fetchSource(name: string, url: string, besideUrl?: (rel: string) => string): ModelSource {
  const near = besideUrl ?? ((rel: string) => new URL(rel.split("/").map(encodeURIComponent).join("/"), url).href);
  return {
    name,
    async read(rel) {
      const res = await fetch(rel ? near(rel) : url);
      if (!res.ok) throw new Error(`${rel || name}: ${res.status} ${res.statusText}`);
      return res.arrayBuffer();
    },
  };
}
