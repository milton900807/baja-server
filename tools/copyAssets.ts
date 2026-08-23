import * as shell from "shelljs";
import * as fs from "fs";

// Compiled runtime assets (safe to refresh on every build).
shell.cp("-R", "src/views", "dist/");
shell.cp("-R", "py-scripts", "dist/");
shell.cp("-R", "config", "dist/");
if (fs.existsSync("nmd")) shell.cp("-R", "nmd", "dist/");

// NOTE: reference_data is intentionally NOT copied into dist (see tools/clean.js).
// The server reads and downloads it under ./reference_data at the project root,
// so copying the large runtime-downloaded files into dist would waste space and
// risk being wiped on the next build.
