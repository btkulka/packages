// After tsc: the stylesheet into dist/, where "@btkulka/ui-kit/styles.css" points, and the fonts the
// Benhäus theme uses (Inter and Inter Tight, SIL Open Font License) beside it, where its @font-face rules look.
import { copyFileSync, cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/styles.css", "dist/styles.css");
cpSync("src/fonts", "dist/fonts", { recursive: true });
