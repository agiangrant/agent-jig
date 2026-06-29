<script lang="ts">
interface SkillItem {
  name: string;
  description?: string;
}
interface Props {
  value: string;
  placeholder?: string;
  files?: string[];
  skills?: SkillItem[];
  disabled?: boolean;
  /** Fired on Enter (without the suggestion popup open and without Shift). */
  onsubmit?: () => void;
}
let {
  value = $bindable(""),
  placeholder = "",
  files = [],
  skills = [],
  disabled = false,
  onsubmit,
}: Props = $props();

let el: HTMLTextAreaElement | undefined = $state();
let sel = $state(0);

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

const open = $derived(suggestions.length > 0);
$effect(() => {
  // Keep the highlighted index in range as the list changes.
  void suggestions;
  if (sel >= suggestions.length) sel = 0;
});

function choose(s: Suggestion) {
  const t = activeToken();
  if (!t || !el) return;
  const caret = el.selectionStart;
  value = value.slice(0, t.start) + s.insert + value.slice(caret);
  const pos = t.start + s.insert.length;
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
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = (sel + 1) % suggestions.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel - 1 + suggestions.length) % suggestions.length;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const s = suggestions[sel];
      if (s) choose(s);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      sel = 0;
      // Collapse the popup by nudging the caret past the token.
      value = `${value} `.trimEnd() + (value.endsWith(" ") ? "" : " ");
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onsubmit?.();
  }
}
</script>

<div class="mdin">
  {#if open}
    <ul class="suggest" role="listbox">
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
    padding: var(--pad-xs) 0;
    outline: none;
  }
  .suggest {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    right: 0;
    max-height: 14em;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
    z-index: 20;
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
  }
  .suggest button.on { background: var(--bg-2); }
  .s-label { font-family: var(--code-font); }
  .s-hint { color: var(--muted); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
