import { postingBlocks } from "@/lib/jobsView";

/** The whole job description, open on the page, in paragraphs, headings and lists (Yong, 2026-11-23). */
export function PostingText({ text }: { text: string | null | undefined }) {
  const blocks = postingBlocks(text);
  if (!blocks.length) return <p className="muted">We don&apos;t have this job&apos;s description.</p>;
  return (
    <div className="posting-text">
      {blocks.map((b, i) => b.kind === "heading" ? <h3 key={i}>{b.text}</h3>
        : b.kind === "list" ? <ul key={i}>{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>
        : <p key={i}>{b.text}</p>)}
    </div>
  );
}
