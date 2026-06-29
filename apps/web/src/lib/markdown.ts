import { Marked } from "marked";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Markdown → HTML for chat, review comments, and skills. Raw HTML in the source
 * is neutralized (escaped, not passed through) so agent/user content can't inject
 * markup — keeping us safe without a heavyweight sanitizer dependency. Fenced and
 * inline code render with our code font; Shiki syntax colour is a later polish.
 */
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Drop raw HTML blocks/inline by escaping them to text.
    html(token) {
      return escapeHtml(token.raw);
    },
    code({ text }) {
      return `<pre class="md-pre"><code>${escapeHtml(text)}</code></pre>`;
    },
  },
});

export function renderMarkdown(source: string): string {
  return md.parse(source ?? "", { async: false }) as string;
}
