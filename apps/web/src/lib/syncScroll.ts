export interface ScrollGroup {
  members?: Set<HTMLElement>;
}

export function createScrollGroup(): ScrollGroup {
  return {};
}

/**
 * Svelte action: keep all elements sharing a group horizontally in sync, so the
 * two sides of a split diff (and stacked hunks) scroll together. No-op without a
 * group. The `!==` guard breaks the feedback loop between linked elements.
 */
export function syncScroll(node: HTMLElement, group: ScrollGroup | undefined) {
  if (!group) return {};
  if (!group.members) group.members = new Set<HTMLElement>();
  const members = group.members;
  members.add(node);
  const onScroll = () => {
    for (const el of members) {
      if (el !== node && el.scrollLeft !== node.scrollLeft) el.scrollLeft = node.scrollLeft;
    }
  };
  node.addEventListener("scroll", onScroll, { passive: true });
  return {
    destroy() {
      members.delete(node);
      node.removeEventListener("scroll", onScroll);
    },
  };
}
