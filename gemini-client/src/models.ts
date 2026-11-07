// models.list and models.get: what the key can see. `GET /v1beta/models` is also the credential test
// Benhäus runs (package.json › benhaus.credential.test).

import { seg, type CallOptions, type Transport } from "./call.js";

/** A model as Google lists it. Google's own field names. */
export interface Model {
  /** `models/gemini-omni-1.1-flash` */
  name: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  /** `generateContent`, `countTokens`, `predictLongRunning`… */
  supportedGenerationMethods?: string[];
  thinking?: boolean;
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
  [key: string]: unknown;
}

export interface ModelList {
  models: Model[];
  /** The next page's token; absent on the last page. */
  nextPageToken?: string;
}

export interface ListModelsOptions extends CallOptions {
  /** Up to 1 000; Google's default is 50. */
  pageSize?: number;
  pageToken?: string;
}

export interface ModelsApi {
  /** One page of `GET /v1beta/models`. */
  list(options?: ListModelsOptions): Promise<ModelList>;
  /** Every page, up to `limit` models. */
  listAll(options?: CallOptions, limit?: number): Promise<Model[]>;
  /** `GET /v1beta/models/{id}`; `models/` in front is fine. */
  get(id: string, options?: CallOptions): Promise<Model>;
}

/** `models/gemini-omni-1.1-flash` → `gemini-omni-1.1-flash`. */
export const modelId = (name: string): string => name.replace(/^models\//, "");

export function modelsApi({ call }: Transport): ModelsApi {
  const list = async (o: ListModelsOptions = {}): Promise<ModelList> => {
    const r = await call<Partial<ModelList> | undefined>("GET", "/models", {
      signal: o.signal,
      query: { pageSize: o.pageSize == null ? undefined : Math.max(1, Math.min(1000, Math.floor(o.pageSize))), pageToken: o.pageToken || undefined },
    });
    return { models: Array.isArray(r?.models) ? r.models : [], nextPageToken: r?.nextPageToken || undefined };
  };
  return {
    list,
    async listAll(o = {}, limit = 5_000) {
      const out: Model[] = [];
      let pageToken: string | undefined;
      do {
        const page = await list({ ...o, pageSize: 1000, pageToken });
        out.push(...page.models);
        pageToken = page.nextPageToken;
      } while (pageToken && out.length < limit);
      return out.slice(0, limit);
    },
    get: (id, o = {}) => call<Model>("GET", `/models/${seg(modelId(id ?? ""), "model id")}`, { signal: o.signal }),
  };
}
