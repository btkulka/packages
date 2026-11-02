// @btkulka/notion-client: Notion's API for Ben's apps. An internal integration's secret in;
// the integration's workspace, search, pages, databases and their rows, blocks as text, and
// page writes. Built on @btkulka/http-kit. Browser-safe: no node:* imports, no Buffer.
// Source imports use .js extensions; no import.meta or top-level await (the CommonJS build needs neither).

export {
  createNotionClient,
  idOf,
  notShared,
  NotionAuthError,
  NotionError,
  MAX_PAGE_SIZE,
  NOTION_API_URL,
  NOTION_VERSION,
  type BlocksOptions,
  type CallOptions,
  type CreatePageInput,
  type NotionClient,
  type NotionClientOptions,
  type NotionErrorCode,
  type QueryOptions,
  type SearchOptions,
  type UpdatePageInput,
} from "./client.js";
export { dashed, notionUrl, parseNotionId, undashed } from "./ids.js";
export { blocksToText, blockText, databaseSchema, iconOf, plainText, propertiesText, propertyText, schemaText, summaryOf, titleOf } from "./text.js";
export type {
  NotionBlock,
  NotionDatabase,
  NotionIcon,
  NotionList,
  NotionObject,
  NotionPage,
  NotionParent,
  NotionSummary,
  NotionUser,
  PropertySchema,
  PropertyValue,
  RichText,
} from "./types.js";
export type { FetchLike, FetchLikeInit, FetchLikeResponse } from "@btkulka/http-kit";
