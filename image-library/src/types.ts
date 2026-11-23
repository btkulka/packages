// The library's shapes: what its calls take and answer (plain JSON, so they cross IPC and MCP as they are).
// Paths are absolute with forward slashes and an upper-case drive letter: D:/source/toejam/pieces/money/concept/a.png.

export interface CollectionInfo {
  id: number;
  parentId: number | null;
  name: string;
  /** Its home on disk: where "move files" puts its images. Optional. */
  folder: string | null;
  note: string;
  /** Images filed directly in it. */
  count: number;
  /** Images in it or anywhere below it (each counted once). */
  total: number;
  /** "toejam › Money Warehouse › Concept art". */
  path: string;
}

/** What the gemini-image CLI writes beside an image as <name>.json. */
export interface Sidecar {
  name?: string;
  prompt?: string;
  system?: string;
  refs?: { path: string; file?: string }[];
  model?: string;
  size?: string;
  aspect?: string;
  text?: string;
  interaction?: string;
  usd?: number;
  secs?: number;
  at?: string;
  [key: string]: unknown;
}

/** What a library item is: a picture, a 3D model (.glb, .gltf, .obj, or a set of OBJ parts named in a <name>.json), or a video. */
export type ItemKind = "image" | "model" | "video";

/** What's in a video, from ffprobe. Its frame size is also the item's width and height (upright, for a rotated phone clip). */
export interface VideoInfo {
  /** Seconds. */
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** The video codec ("h264", "hevc", "vp9", "prores"…). */
  codec: string | null;
  /** The audio codec, or null when it's silent. */
  audio: string | null;
  /** kbit/s, the whole file's. */
  bitrate?: number;
  /** "mov" (which ffprobe calls mp4 and m4v too), "matroska" (mkv and webm), "avi"… */
  container?: string;
  /** Why it couldn't be read (no ffprobe, a half-written file); it's read again when the file changes. */
  error?: string;
}

export interface MeshTexture {
  name: string;
  /** What the materials use it for: "base colour", "normal", "metal/rough"… */
  role?: string;
  width?: number;
  height?: number;
  mime?: string;
  bytes?: number;
  /** Its own file, when it isn't inside the model. */
  file?: string;
}

/** What's in a 3D model, read from its file (or a set's sidecar). */
export interface MeshInfo {
  format: "glb" | "gltf" | "obj" | "set";
  triangles: number | null;
  vertices: number | null;
  meshes?: number;
  materials?: number;
  vertexColors: boolean;
  uvs?: boolean;
  textures: MeshTexture[];
  /** Width, height and depth in its own units. */
  size?: [number, number, number];
  /** A set's OBJ parts, with their colours from the sidecar. */
  parts?: { file: string; label?: string; color?: string; triangles?: number; missing?: boolean }[];
  /** glTF extensions it needs (KHR_draco_mesh_compression…). */
  extensions?: string[];
  /** Why it couldn't be read (a half-written file); it's read again when the file changes. */
  error?: string;
}

/** The concept image a model came from, and how Gallery knows. */
export interface ConceptLink {
  id: number;
  path: string;
  name: string;
  mtime: number;
  missing: boolean;
  /** "set" (by hand), "sidecar" (its .meta.json names it) or "name" (they share a name). */
  how: "set" | "sidecar" | "name";
}

export interface ImageRow {
  id: number;
  /** A picture, a 3D model or a video. */
  kind: ItemKind;
  path: string;
  name: string;
  folder: string;
  ext: string;
  bytes: number;
  /** A picture's or a video's frame size (null for a model). */
  width: number | null;
  height: number | null;
  /** File modified time, ms. Thumbnails are keyed on it. */
  mtime: number;
  /** When it was made: the sidecar's `at`, else the file's modified time (ISO). */
  created: string;
  addedAt: string;
  missing: boolean;
  prompt: string | null;
  model: string | null;
  usd: number | null;
  tags: string[];
  /** A model's triangles (null for a picture, or a model that couldn't be read). */
  tris: number | null;
  /** What's in a model; null for a picture or a video. */
  mesh: MeshInfo | null;
  /** What's in a video (length, rate, codecs); null for a picture or a model. */
  video: VideoInfo | null;
  /** Times it's been looked at: opened large on the Gallery page (counted once it's been up a moment). */
  views: number;
  /** When it was last looked at (ISO), or null. */
  viewedAt: string | null;
  /** The stack it's in (versions of one thing shown as one tile: a model's textured and untextured meshes), or null. */
  stack: StackRef | null;
}

/** An item's stack: its members in order, the first being the front runner (the tile a collapsed stack shows). */
export interface StackRef {
  id: number;
  /** Every member's id, the front first. */
  ids: number[];
  /** Whether this item is the front. */
  front: boolean;
}

/** A member of a stack, as the inspector lists them. */
export interface StackMember {
  id: number;
  kind: ItemKind;
  path: string;
  name: string;
  mtime: number;
  missing: boolean;
  tris: number | null;
  textures: number;
  /** A video's length in seconds. */
  duration?: number | null;
}

export interface ImageDetail extends ImageRow {
  note: string;
  /** gemini-image's sidecar for a picture (or the same <name>.json beside a video); a model's <name>.meta.json (trellis-client's seed, image, model, quality, secs). */
  sidecar: Sidecar | null;
  collections: { id: number; path: string }[];
  /** A model's concept image, when its sidecar or a matching name says which. */
  concept: ConceptLink | null;
  /** A picture's models: the ones made from it. */
  models: { id: number; path: string; name: string; mtime: number; tris: number | null }[];
  /** Files that go with it when it moves or is deleted (its sidecars, a model's parts, .mtl, textures). */
  companions: string[];
  /** Its stack's members in order, the front first (empty when it's in no stack). */
  stacked: StackMember[];
}

/** size: the largest file first, smallest: the smallest first. views: the most looked-at first (the Gallery page counts them). */
export type SortKey = "newest" | "oldest" | "added" | "name" | "size" | "smallest" | "cost" | "views";

export interface SearchQuery {
  /** Words matched against name, folder, prompt, model, note and tags. `tag:x`, `model:x`, `is:starred`, `is:model`, `is:image`, `is:video`, `size:>100mb`, `-word` and "quoted phrases" work too. */
  text?: string;
  /** Only images in this collection (and below it unless includeSub is false). */
  collectionId?: number;
  includeSub?: boolean;
  /** Only pictures, only 3D models, or only videos. */
  kind?: ItemKind;
  /** Any of these kinds (the Gallery page's Type filter); empty is every kind. */
  kinds?: ItemKind[];
  /** Only images in no collection at all. */
  unfiled?: boolean;
  /** Must have every one of these tags. */
  tags?: string[];
  /** Must have at least one of these (empty is no condition). */
  anyTags?: string[];
  /** Must have none of these. */
  notTags?: string[];
  untagged?: boolean;
  /** Part of the model's name. */
  model?: string;
  /** Made by any of these models, by their exact names (the Gallery page's Model filter). */
  models?: string[];
  /** Inclusive ISO dates (YYYY-MM-DD or full) on `created`. */
  from?: string;
  to?: string;
  /** Inclusive bounds on the file's size in bytes. */
  minBytes?: number;
  maxBytes?: number;
  /** hide (default), only, or show. */
  missing?: "hide" | "only" | "show";
  ids?: number[];
  /** collapse (default): a stack is one item, its first member that matches (the front, unless it doesn't).
   *  expand: every member on its own. Asking by ids expands. */
  stacks?: "collapse" | "expand";
  /** With collapse: these stacks show every matching member, side by side in stack order. */
  openStacks?: number[];
  sort?: SortKey;
  /** The sort the other way round: oldest first for newest, Z to A for name, the fewest views first for views. */
  reverse?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  total: number;
  /** Every match's file size added up, a closed stack's members too (all of them on disk, whatever limit and offset show). */
  bytes: number;
  items: ImageRow[];
}

export interface TagInfo {
  id: number;
  name: string;
  count: number;
}

/**
 * How many of a search's matches each filter's options would give (Library.facets): each counted
 * with every other filter on but its own off, so the counts say what picking one more would show.
 * A closed stack counts once, as its tile does.
 */
export interface SearchFacets {
  kinds: Record<ItemKind, number>;
  /** Every tag with a match, the most used first. */
  tags: { name: string; count: number }[];
  /** Every model with a match, the most used first; items no model made aren't counted. */
  models: { name: string; count: number }[];
  /** How many of the matches are starred, and how many there are with Starred off. */
  starred: { on: number; all: number };
}

export interface WatchInfo {
  id: number;
  folder: string;
  collectionId: number | null;
  collectionPath: string | null;
  recursive: boolean;
  enabled: boolean;
  lastScan: string | null;
  /** Whether the folder is there right now. */
  exists: boolean;
}

export interface ScanResult {
  seen: number;
  added: number;
  updated: number;
  missing: number;
  errors: string[];
}

export interface AddResult {
  added: number[];
  existing: number[];
  skipped: string[];
}

export interface MoveResult {
  moved: { id: number; from: string; to: string }[];
  failed: { id: number; error: string }[];
  /** Files that should have gone along and didn't (a name already taken there). */
  warnings?: string[];
}

export type FileMode = "add" | "move" | "remove";

export interface LibraryInfo {
  db: string;
  /** Pictures (not missing). */
  images: number;
  /** 3D models (not missing). */
  meshes: number;
  /** Videos (not missing). */
  videos: number;
  missing: number;
  collections: number;
  tags: number;
  watches: number;
  models: string[];
}

/** What another process asked the page showing the library to show (Claude, through an MCP server). */
export interface ViewRequest {
  collectionId?: number | null;
  /** A search, as typed in the search field. */
  text?: string;
  /** The page's filters and sort; any left out go back to their defaults (no filter, newest first). */
  filters?: ViewFilters;
  /** Open this image in the viewer. */
  imageId?: number;
  /** Open these side by side (2–4). */
  compare?: number[];
  at: number;
}

/** When something was made, as the Gallery page's Made filter offers it: since the start of today, or the last 7 days, month or year. */
export type MadeBand = "today" | "week" | "month" | "year";
/** The Gallery page's Size filter: under 1 MB, 1–10 MB, 10–100 MB, 100 MB–1 GB, over 1 GB. */
export type SizeBand = "tiny" | "small" | "medium" | "large" | "huge";

/** The Gallery page's filters and sort, as open_gallery sets them. */
export interface ViewFilters {
  kinds?: ItemKind[];
  starred?: boolean;
  tags?: string[];
  /** all (default): every one of the tags; any: at least one. */
  tagMatch?: "all" | "any";
  models?: string[];
  made?: MadeBand;
  size?: SizeBand;
  sort?: SortKey;
  reverse?: boolean;
}
