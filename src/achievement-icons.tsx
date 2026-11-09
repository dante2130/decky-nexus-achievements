import { useId } from "react";
import rareSvg from "./assets/rare.svg?inline";
import mythicSvg from "./assets/mythic.svg?inline";

function VectorIcon({ source, size }: { source: string; size: number }) {
  const id = `nexus-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Trusted bundled artwork is rendered directly; Steam popup windows can block data-URL images.
  const markup = source.replace(/^\s*<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")
    .replace(/id="([^"]+)"/g, (_, name: string) => `id="${id}-${name}"`)
    .replace(/url\(#([^)]+)\)/g, (_, name: string) => `url(#${id}-${name})`);
  const viewBox = source.match(/viewBox="([^"]+)"/)?.[1] || "0 0 128 128";
  return <svg viewBox={viewBox} xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width={size} height={size}
    style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: markup }} />;
}
export function RareIcon({ size = 16 }: { size?: number }) { return <VectorIcon source={rareSvg} size={size} />; }
export function MythicIcon({ size = 16 }: { size?: number }) { return <VectorIcon source={mythicSvg} size={size} />; }
