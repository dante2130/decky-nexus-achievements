import deckyPlugin from "@decky/rollup";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const config = deckyPlugin({});
const suffix = "?nexus-inline-svg";
export default {
  ...config,
  plugins: [
    {
      name: "inline-vector-artwork",
      resolveId(source, importer) {
        if (!importer || !source.endsWith(".svg?inline")) return null;
        return resolve(dirname(importer), source.slice(0, -"?inline".length)) + suffix;
      },
      load(id) {
        if (!id.endsWith(suffix)) return null;
        const source = readFileSync(id.slice(0, -suffix.length), "utf8");
        if (!source.trimStart().startsWith("<svg")) throw new Error("Expected inline SVG artwork");
        return { code: `export default ${JSON.stringify(source)};`, map: { mappings: "" } };
      },
    },
    ...config.plugins,
  ],
};
