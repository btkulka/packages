// ---- flattened shapes (what candybar-manager stores and shows) ----

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
  album_image_url: string | null;
  /** First four characters of the album's release_date. */
  release_year: string | null;
  duration_ms: number;
  preview_url: string | null;
  external_url: string;
  popularity: number;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  external_url: string;
  image_url: string | null;
}

export interface SpotifySearchResult {
  tracks: SpotifyTrack[];
  artists: SpotifyArtist[];
}

export interface SpotifyPlaylistInfo {
  id: string;
  name: string;
  description: string;
  /** What Spotify reports, including local files and unavailable tracks that get skipped. */
  trackCount: number;
  imageUrl: string | null;
  externalUrl: string;
  owner: string;
}

// ---- raw Web API objects (the fields the apps read; Spotify sends more) ----

export interface SpotifyImageObject {
  url: string;
  height?: number | null;
  width?: number | null;
}

export interface SpotifyArtistObject {
  id: string;
  name: string;
  /** `followers.total` is the public follower count nhi-dashboard records. */
  followers?: { total: number | null; href?: string | null };
  popularity?: number;
  genres?: string[];
  images?: SpotifyImageObject[];
  external_urls?: { spotify?: string };
  [key: string]: unknown;
}

export interface SpotifyAlbumObject {
  id: string;
  name: string;
  artists: { id: string; name: string; [key: string]: unknown }[];
  images: SpotifyImageObject[];
  release_date?: string;
  external_urls?: { spotify?: string };
  [key: string]: unknown;
}

/** A track object as the search and playlist endpoints return it. */
export interface SpotifyTrackObject {
  id: string;
  name: string;
  artists: { name: string; [key: string]: unknown }[];
  album: { name: string; images?: SpotifyImageObject[]; release_date?: string; [key: string]: unknown };
  duration_ms: number;
  preview_url?: string | null;
  external_urls?: { spotify?: string };
  popularity?: number;
  [key: string]: unknown;
}
