/**
 * A deliberately tiny markdown -> HTML renderer for the preview pane. It covers
 * the basics an LLM tends to emit (headings, bold/italic, inline code, links,
 * lists) and HTML-escapes first so the model's output can't inject markup.
 * For anything richer, swap in `streamdown` (already in the repo catalog).
 */
const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const inline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

export const renderMarkdown = (markdown: string): string => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+\.\s+(.*)$/.exec(line);

    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (bullet) {
      flushParagraph();
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push(`<li>${inline(bullet[1]!)}</li>`);
    } else if (numbered) {
      flushParagraph();
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push(`<li>${inline(numbered[1]!)}</li>`);
    } else if (line.trim() === '') {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  closeList();
  return html.join('\n');
};

/**
 * Pull a leading `# Heading` off a draft to seed the title field, returning the
 * remaining body. Falls back to the first non-empty line.
 */
export type TitleAndBody = { title: string; body: string };

export const splitTitle = (markdown: string): TitleAndBody => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((l) => /^#\s+/.test(l.trim()));
  if (headingIndex !== -1) {
    const title = lines[headingIndex]!.replace(/^#\s+/, '').trim();
    const body = [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 1)].join('\n').trim();
    return { title, body };
  }
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? '';
  return { title: firstNonEmpty.trim().slice(0, 80), body: markdown.trim() };
};
