// After tsc: the stylesheet into dist/, where "@btkulka/ui-kit/styles.css" points.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/styles.css", "dist/styles.css");
