<script lang="ts">
interface SkillItem {
  name: string;
  description?: string;
}
type SubmitMode = "enter" | "mod-enter" | "none";
interface Props {
  value: string;
  placeholder?: string;
  files?: string[];
  skills?: SkillItem[];
  disabled?: boolean;
  /** Which keystroke fires onsubmit when the popup is closed. Default "enter"
   *  keeps the conversation composer unchanged. "mod-enter" = ⌘/Ctrl+Enter
   *  (comment editors); "none" = never (Enter always inserts a newline). */
  submit?: SubmitMode;
  /** Suggestion popup direction. "auto" (default) picks up/down by the space
   *  available around the caret; force with "up"/"down". */
  placement?: "up" | "down" | "auto";
  /** Focus the textarea on mount (replaces use:focusOnMount / use:autofocus). */
  autofocus?: boolean;
  /** Fired per `submit` when the popup is closed. */
  onsubmit?: () => void;
  /** Fired on Escape when the popup is closed (comment/reject cancel). */
  oncancel?: () => void;
}
let {
  value = $bindable(""),
  placeholder = "",
  files = [],
  skills = [],
  disabled = false,
  submit = "enter",
  placement = "auto",
  autofocus = false,
  onsubmit,
  oncancel,
}: Props = $props();

let el: HTMLTextAreaElement | undefined = $state();
let sel = $state(0);
// Forced closed after a pick (or Escape); the suggestions derived can still see
// a token under the caret (which is repositioned a microtask later), so this
// guarantees the popup closes. Cleared on the next real keystroke.
let hideSuggest = $state(false);
$effect(() => {
  if (autofocus) el?.focus();
});

interface Suggestion {
  label: string;
  hint?: string;
  insert: string;
}

/** The @… or /… token under the caret, if any (trigger must start a word). */
function activeToken(): { trigger: "@" | "/"; query: string; start: number } | null {
  if (!el) return null;
  const caret = el.selectionStart;
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    if (ch === "@" || ch === "/") break;
    i--;
  }
  if (i < 0) return null;
  const trigger = value[i] as "@" | "/";
  const before = i === 0 ? " " : value[i - 1];
  if (before !== " " && before !== "\n" && before !== "\t") return null;
  return { trigger, query: value.slice(i + 1, caret), start: i };
}

const token = $derived.by(() => {
  // Re-evaluate whenever value changes (caret moves with edits).
  void value;
  return activeToken();
});

const suggestions = $derived.by<Suggestion[]>(() => {
  const t = token;
  if (!t) return [];
  const q = t.query.toLowerCase();
  if (t.trigger === "@") {
    return files
      .filter((f) => f.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({ label: f, insert: `@${f} ` }));
  }
  return skills
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, 8)
    .map((s) => ({ label: `/${s.name}`, hint: s.description, insert: `/${s.name} ` }));
});

const open = $derived(!hideSuggest && suggestions.length > 0);
$effect(() => {
  // Keep the highlighted index in range as the list changes.
  void suggestions;
  if (sel >= suggestions.length) sel = 0;
});

// The popup is position:fixed and anchored to the CARET LINE (not the whole
// textarea) so it sits next to the text you're typing, and can't be clipped by
// an ancestor modal / scroll container's overflow. The caret's pixel position
// is measured with a hidden mirror div that mimics the textarea's text layout.
type Anchor = { left: number; width: number; top: number; bottom: number };
let anchor = $state<Anchor | null>(null);
const MIRROR_PROPS = [
  "box-sizing", "width", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "font-style", "font-variant", "font-weight", "font-stretch", "font-size", "font-family",
  "line-height", "letter-spacing", "text-transform", "word-spacing", "tab-size", "text-indent",
];
function measure() {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const p of MIRROR_PROPS) mirror.style.setProperty(p, style.getPropertyValue(p));
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";
  const caret = el.selectionStart ?? value.length;
  mirror.textContent = value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = value.slice(caret) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const markerTop = marker.offsetTop;
  document.body.removeChild(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  const top = rect.top + borderTop + markerTop - el.scrollTop;
  anchor = { left: rect.left, width: rect.width, top, bottom: top + lineHeight };
}
$effect(() => {
  void value; // re-measure as the caret / token changes
  if (open) measure();
  else anchor = null;
});
$effect(() => {
  if (!open) return;
  const m = () => measure();
  window.addEventListener("scroll", m, true);
  window.addEventListener("resize", m);
  return () => {
    window.removeEventListener("scroll", m, true);
    window.removeEventListener("resize", m);
  };
});
const POPUP_MAX = 240; // ~14em popup + padding, for the auto up/down choice
const suggestStyle = $derived.by(() => {
  const a = anchor;
  if (!a) return "";
  const base = `left:${Math.round(a.left)}px; width:${Math.round(a.width)}px;`;
  const spaceBelow = window.innerHeight - a.bottom;
  const down =
    placement === "down" ? true : placement === "up" ? false : spaceBelow >= POPUP_MAX || spaceBelow >= a.top;
  return down
    ? `${base} top:${Math.round(a.bottom + 4)}px;`
    : `${base} bottom:${Math.round(window.innerHeight - a.top + 4)}px;`;
});

function choose(s: Suggestion) {
  const t = activeToken();
  if (!t || !el) return;
  const caret = el.selectionStart;
  value = value.slice(0, t.start) + s.insert + value.slice(caret);
  const pos = t.start + s.insert.length;
  // Close the popup now; it reopens when the user types a fresh @/​/ token.
  hideSuggest = true;
  // Restore caret after the inserted mention.
  queueMicrotask(() => {
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  });
}

function onkeydown(e: KeyboardEvent) {
  if (open) {
    // The popup owns navigation keys — stop them reaching a parent handler
    // (e.g. a modal's ⌘Enter submit) while a suggestion is being chosen.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      sel = (sel + 1) % suggestions.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      sel = (sel - 1 + suggestions.length) % suggestions.length;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const s = suggestions[sel];
      if (s) choose(s);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      sel = 0;
      hideSuggest = true; // close the popup without mutating the text
      return;
    }
    // Any other key falls through so typing keeps filtering.
  }

  // Popup closed:
  if (e.key === "Escape") {
    oncancel?.();
    return;
  }
  if (e.key === "Enter") {
    const mod = e.metaKey || e.ctrlKey;
    if (submit === "enter" && !e.shiftKey && !mod) {
      e.preventDefault();
      onsubmit?.();
    } else if (submit === "mod-enter" && mod) {
      e.preventDefault();
      onsubmit?.();
    }
    // submit === "none": Enter inserts a newline; a parent may handle mod+Enter.
  }
}
</script>

<div class="mdin">
  {#if open}
    <ul class="suggest" role="listbox" style={suggestStyle}>
      {#each suggestions as s, i (s.label)}
        <li>
          <button
            type="button"
            class:on={i === sel}
            onmousedown={(e) => {
              e.preventDefault();
              choose(s);
            }}
          >
            <span class="s-label">{s.label}</span>
            {#if s.hint}<span class="s-hint">{s.hint}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <textarea
    bind:this={el}
    bind:value
    {placeholder}
    {disabled}
    rows="1"
    {onkeydown}
    oninput={() => (hideSuggest = false)}
  ></textarea>
</div>

<style>
  .mdin { position: relative; flex: 1; min-width: 0; }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    min-height: 2.2em;
    max-height: 40vh;
    field-sizing: content;
    background: transparent;
    border: 0;
    color: var(--fg);
    font: inherit;
    /* Match the component text scale (density + UI-size aware), not the raw
       body size — otherwise the input reads larger than the rest of the UI. */
    font-size: var(--fs-sm);
    line-height: 1.5;
    padding: var(--pad-xs) 0;
    outline: none;
  }
  /* Fixed + JS-anchored (see suggestStyle) so a modal/scroll container's
     overflow can't clip it. top/left/width/bottom come from the inline style. */
  .suggest {
    position: fixed;
    max-height: 14em;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
    z-index: 60;
  }
  .suggest button {
    display: flex;
    align-items: baseline;
    gap: var(--gap-sm);
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    color: var(--fg);
    border-radius: 4px;
    padding: 3px 6px;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
  }
  .suggest button.on { background: var(--bg-2); }
  .s-label { font-family: var(--code-font); }
  .s-hint { color: var(--muted); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
