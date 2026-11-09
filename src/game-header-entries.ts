// Other plugins retain references and positional anchors in this shared array.
// Append only our keyed entries; never replace the array or shift existing items.
export function appendGameHeaderEntries(children: unknown[], entries: ReadonlyArray<{ key: unknown }>): void {
  for (const entry of entries) {
    if (!children.some(child => child !== null && typeof child === "object"
      && "key" in child && child.key === entry.key)) children.push(entry);
  }
}
