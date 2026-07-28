// src/types.ts

/**
 * Represents a row from the transcript CSV.
 * Every column is parsed as a string, but we ensure transcript_id always exists.
 */
export interface CsvRow extends Record<string, string> {
  transcript_id: string;
}

/**
 * Expected request body for the /og-images endpoint.
 */
export interface OgImageBody {
  user: string;      // e.g. "jane@example.com"
  spath?: string;    // optional subpath under og-images
  name: string;      // filename (with or without ".png")
  value: string;     // base64 string (may include data URL prefix)
}
