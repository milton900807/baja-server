import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";
import type { CsvRow } from "./types.js";

const REQUIRED_COLUMN = "transcript_id" as const;

// Always resolve relative path from project root
const CSV_PATH = path.resolve(process.cwd(), "nmd", "exon_drop_impact.csv");

export function getCsvPath(): string {
  return CSV_PATH;
}
export async function buildIndex(): Promise<Map<string, CsvRow>> {
  return new Promise((resolve, reject) => {
    const map = new Map<string, CsvRow>();

    console.log("🔍 Building transcript index from CSV…");

    let count = 0;

    const parser = parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
    });

    parser.once("headers", (headers: string[]) => {
      if (!headers.includes(REQUIRED_COLUMN)) {
        reject(
          new Error(
            `CSV missing required column '${REQUIRED_COLUMN}'. Found: ${headers.join(", ")}`
          )
        );
      }
    });

    parser.on("readable", () => {
      let rec: CsvRow | null;
      while ((rec = parser.read() as CsvRow | null) !== null) {
        const key = rec.transcript_id;
        if (key && !map.has(key)) map.set(key, rec);

        count++;
        // log every 10k rows to avoid flooding console
        if (count % 10000 === 0) {
          console.log(`…processed ${count.toLocaleString()} rows`);
        }
      }
    });

    parser.once("error", reject);

    parser.once("end", () => {
      console.log(
        `✅ Finished building index. Total transcripts: ${map.size.toLocaleString()}`
      );
      resolve(map);
    });

    fs.createReadStream(CSV_PATH).on("error", reject).pipe(parser);
  });
}


export async function streamLookup(id: string): Promise<CsvRow | null> {
  return new Promise((resolve, reject) => {
    let found: CsvRow | null = null;

    const parser = parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
    });

    parser.once("headers", (headers: string[]) => {
      if (!headers.includes(REQUIRED_COLUMN)) {
        reject(new Error(`CSV missing required column '${REQUIRED_COLUMN}'. Found: ${headers.join(", ")}`));
      }
    });

    parser.on("readable", () => {
      let rec: CsvRow | null;
      while ((rec = parser.read() as CsvRow | null) !== null) {
        if (rec.transcript_id === id) {
          found = rec;
          parser.destroy();
          break;
        }
      }
    });

    parser.once("error", reject);
    parser.once("end", () => resolve(found));

    fs.createReadStream(CSV_PATH).on("error", reject).pipe(parser);
  });
}
