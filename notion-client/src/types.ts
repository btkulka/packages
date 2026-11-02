// The shapes Notion's API answers with, as far as this package reads them. Every object keeps
// an index signature: Notion adds fields, and callers can reach anything not typed here.

export interface RichText {
  type?: "text" | "mention" | "equation" | string;
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  [key: string]: unknown;
}

export type NotionIcon =
  | { type: "emoji"; emoji: string }
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string; expiry_time?: string } }
  | { type: string; [key: string]: unknown };

export interface NotionUser {
  object: "user";
  id: string;
  type?: "person" | "bot" | string;
  name?: string | null;
  avatar_url?: string | null;
  person?: { email?: string };
  /** For an integration's own user (`me`): who owns it and which workspace it's in. */
  bot?: {
    owner?: { type: "workspace" | "user" | string; workspace?: boolean; user?: NotionUser };
    workspace_name?: string | null;
    workspace_id?: string;
    workspace_limits?: { max_file_upload_size_in_bytes?: number };
  };
  [key: string]: unknown;
}

export interface NotionParent {
  type: "database_id" | "page_id" | "block_id" | "workspace" | string;
  database_id?: string;
  page_id?: string;
  block_id?: string;
  workspace?: boolean;
}

/** A property's value on a page: `type` says which key holds it (`title`, `select`, `date`…). */
export interface PropertyValue {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/** A property's definition on a database. */
export interface PropertySchema {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

export interface NotionPage {
  object: "page";
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  in_trash?: boolean;
  icon?: NotionIcon | null;
  cover?: unknown;
  parent: NotionParent;
  properties: Record<string, PropertyValue>;
  url: string;
  public_url?: string | null;
  [key: string]: unknown;
}

export interface NotionDatabase {
  object: "database";
  id: string;
  created_time: string;
  last_edited_time: string;
  title: RichText[];
  description?: RichText[];
  icon?: NotionIcon | null;
  cover?: unknown;
  parent: NotionParent;
  properties: Record<string, PropertySchema>;
  url: string;
  public_url?: string | null;
  archived: boolean;
  in_trash?: boolean;
  is_inline?: boolean;
  [key: string]: unknown;
}

/** A block: `type` says which key holds its content (`paragraph`, `heading_1`, `to_do`…). */
export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children: boolean;
  archived?: boolean;
  in_trash?: boolean;
  created_time?: string;
  last_edited_time?: string;
  parent?: NotionParent;
  /** Filled in by `blocks()` for the blocks it descended into. Not part of Notion's answer. */
  children?: NotionBlock[];
  [key: string]: unknown;
}

export interface NotionList<T> {
  object: "list";
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  type?: string;
  [key: string]: unknown;
}

export type NotionObject = NotionPage | NotionDatabase;

/** A page or database in a few words, for lists (search results, a database's rows). */
export interface NotionSummary {
  id: string;
  kind: "page" | "database";
  title: string;
  url: string;
  /** An emoji, or the address of an image. */
  icon?: string;
  lastEdited: string;
  parent: { type: string; id?: string };
}
