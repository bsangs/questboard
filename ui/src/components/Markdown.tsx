"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BOARD_SERVER_URL } from "@/lib/api";

/**
 * Lightweight markdown renderer for comments and inline notes.
 *
 * Workers/reviewers/mergers tend to write `## Notes` sections, code
 * blocks, bullet lists, and the occasional table — all standard
 * GitHub-flavored markdown. This component renders that input as
 * actual formatted prose instead of a `<pre>`-style raw dump.
 *
 * Tailwind: we don't use `@tailwindcss/typography` here (it's not in
 * the deps and would pull in a meaningful payload). Instead, every
 * element gets explicit utility classes tuned for the drawer's narrow
 * width and small (~13px) base size.
 *
 * `react-markdown` already escapes HTML by default — there's no need
 * for a sanitizer plugin as long as we don't enable rehype-raw.
 *
 * ── Image URL rewriting ────────────────────────────────────────────
 *
 * The card / composer attachment flow embeds local images using
 *   ![alt](attachments/<filename>)   — per-card / per-thread, OR
 *   ![alt](_uploads/<token>/<filename>)  — temp pool (pre-promotion).
 *
 * The renderer rewrites both to absolute URLs that hit the server's
 * static-attachment routes. External http(s) URLs pass through.
 */

type AttachmentScope =
  | { kind: "card"; cardId: string }
  | { kind: "composer"; threadId: string }
  // Used in the NewCardModal preview where the card id doesn't exist
  // yet but pasted images are stored under a token in the upload pool.
  | { kind: "uploads"; token: string }
  | { kind: "none" };

function rewriteImgSrc(
  src: string | undefined,
  scope: AttachmentScope,
): string | undefined {
  if (!src) return src;
  // Absolute URLs (http/https/data:) pass through untouched.
  if (/^([a-z]+:)?\/\//i.test(src) || src.startsWith("data:")) return src;

  // Pool URLs are scope-agnostic — the token is embedded in the path,
  // so the renderer can resolve them regardless of the surrounding
  // scope. This makes draft-mode previews work in NewCardModal.
  const poolMatch = src.match(/^_uploads\/([a-f0-9]{16,64})\/(.+)$/);
  if (poolMatch) {
    const [, token, name] = poolMatch;
    return `${BOARD_SERVER_URL}/api/uploads/${token}/${encodeURIComponent(name)}`;
  }

  // attachments/<filename> — needs scope to resolve.
  if (src.startsWith("attachments/")) {
    const name = src.slice("attachments/".length);
    if (scope.kind === "card") {
      return `${BOARD_SERVER_URL}/api/cards/${scope.cardId}/attachments/${encodeURIComponent(name)}`;
    }
    if (scope.kind === "composer") {
      return `${BOARD_SERVER_URL}/api/composer/threads/${encodeURIComponent(scope.threadId)}/attachments/${encodeURIComponent(name)}`;
    }
    if (scope.kind === "uploads") {
      // The card hasn't been created yet — fall back to the upload
      // pool URL so the preview works during drafting.
      return `${BOARD_SERVER_URL}/api/uploads/${scope.token}/${encodeURIComponent(name)}`;
    }
    // No scope — leave the broken relative URL; it'll show as a broken
    // image, which is the right signal that something is off.
    return src;
  }

  return src;
}

export interface MarkdownProps {
  children: string;
  /** Attach this Markdown render to a card so `attachments/foo` resolves. */
  cardId?: string;
  /** Or to a composer thread. */
  composerThreadId?: string;
  /** Or to a pre-create draft (NewCardModal preview). */
  uploadToken?: string;
}

export function Markdown({
  children,
  cardId,
  composerThreadId,
  uploadToken,
}: MarkdownProps) {
  // Order matters: card scope wins, then composer, then upload-pool. In
  // practice only one is set per call site.
  const scope: AttachmentScope = cardId
    ? { kind: "card", cardId }
    : composerThreadId
      ? { kind: "composer", threadId: composerThreadId }
      : uploadToken
        ? { kind: "uploads", token: uploadToken }
        : { kind: "none" };

  return (
    <div className="markdown text-[13px] leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-1.5 mt-3 text-[14px] font-semibold first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0">
              {children}
            </h3>
          ),
          ul: ({ children }) => (
            <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
            >
              {children}
            </a>
          ),
          // Image: rewrite scope-relative `attachments/...` and pool
          // URLs to absolute server URLs. Wrap in an <a> so the user
          // can click to open the full-size in a new tab.
          img: ({ src, alt, title }) => {
            const resolved = rewriteImgSrc(typeof src === "string" ? src : undefined, scope);
            return (
              <a
                href={resolved}
                target="_blank"
                rel="noopener noreferrer"
                className="my-2 inline-block max-w-full overflow-hidden rounded border border-border-strong align-top hover:border-border-strong"
                title={title || alt || "open full-size"}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={resolved}
                  alt={alt ?? ""}
                  loading="lazy"
                  className="block max-h-96 max-w-full object-contain bg-[var(--bg-muted)]"
                />
              </a>
            );
          },
          code: ({ children, className }) => {
            // remark turns ``` blocks into <pre><code class="language-..."> and
            // inline `…` into bare <code>. We only need to differentiate by
            // whether `className` is present (i.e. fenced).
            if (className) {
              return (
                <code className={`${className} font-mono text-[12px]`}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-gray-100 px-1 py-px font-mono text-[12px] text-ink">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded bg-gray-100 px-3 py-2 text-[12px] leading-snug last:mb-0">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-gray-300 pl-3 text-ink-muted last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-border-strong" />,
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto last:mb-0">
              <table className="min-w-full border-collapse text-[12px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border-strong bg-gray-50 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border-strong px-2 py-1 align-top">
              {children}
            </td>
          ),
          input: (props) => {
            // GFM task-list checkboxes — keep them visible but disabled.
            if (props.type === "checkbox") {
              return (
                <input
                  {...props}
                  disabled
                  className="mr-1.5 translate-y-[1px] accent-emerald-600"
                />
              );
            }
            return <input {...props} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
