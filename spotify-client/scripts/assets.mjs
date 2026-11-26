// After tsc: the search box's stylesheet into dist/, where "@btkulka/spotify-client/search.css" points.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/search.css", "dist/search.css");
