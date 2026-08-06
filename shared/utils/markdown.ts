import TurndownService from 'turndown';

const NON_CONTENT_TAGS: Array<keyof HTMLElementTagNameMap> = ['style', 'script', 'noscript', 'link', 'meta', 'title'];
const BOTTOM_BAR_IDS = new Set(['content_bottom_area', 'js_article_bottom_bar']);
const TABLE_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'del',
  'em',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);
const DROP_TABLE_TAGS = new Set([
  'base',
  'embed',
  'iframe',
  'link',
  'math',
  'meta',
  'noscript',
  'object',
  'script',
  'style',
  'svg',
]);
const GLOBAL_TABLE_ATTRIBUTES = new Set(['align', 'colspan', 'rowspan', 'scope', 'span']);

function isBottomBar(node: Element): boolean {
  return BOTTOM_BAR_IDS.has(node.id) || Array.from(node.classList).includes('__bottom-bar__');
}

function isSafeTableUrl(value: string, allowMailto: boolean, allowRasterDataImage: boolean): boolean {
  const compact = Array.from(value.trim(), character => (character.charCodeAt(0) <= 0x20 ? '' : character));
  const normalized = compact.join('');
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('data:')) {
    return (
      allowRasterDataImage && /^data:image\/(?:avif|bmp|gif|jpe?g|png|webp);base64,[a-z0-9+/]+=*$/i.test(normalized)
    );
  }
  try {
    const protocol = new URL(normalized, 'https://wechat2md.invalid/').protocol;
    return protocol === 'http:' || protocol === 'https:' || (allowMailto && protocol === 'mailto:');
  } catch {
    return false;
  }
}

function sanitizeTableElement(element: Element): void {
  for (const child of Array.from(element.children)) {
    const tagName = child.tagName.toLowerCase();
    if (isBottomBar(child) || DROP_TABLE_TAGS.has(tagName)) {
      child.remove();
      continue;
    }

    sanitizeTableElement(child);
    if (!TABLE_TAGS.has(tagName)) {
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }

    for (const attribute of Array.from(child.attributes)) {
      const name = attribute.name.toLowerCase();
      const keepGlobal = GLOBAL_TABLE_ATTRIBUTES.has(name);
      const keepLink = tagName === 'a' && ['href', 'title'].includes(name);
      const keepImage = tagName === 'img' && ['alt', 'height', 'src', 'title', 'width'].includes(name);
      if (!keepGlobal && !keepLink && !keepImage) child.removeAttribute(attribute.name);
    }

    const href = child.getAttribute('href');
    if (href && !isSafeTableUrl(href, true, false)) child.removeAttribute('href');
    const src = child.getAttribute('src');
    if (src && !isSafeTableUrl(src, false, true)) child.removeAttribute('src');
  }
}

function sanitizedTableHtml(node: Node): string {
  const table = node.cloneNode(true) as Element;
  sanitizeTableElement(table);
  for (const attribute of Array.from(table.attributes)) {
    if (!GLOBAL_TABLE_ATTRIBUTES.has(attribute.name.toLowerCase())) table.removeAttribute(attribute.name);
  }
  return table.outerHTML;
}

/** Create the shared Markdown converter used by browser and server exports. */
export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });

  service.addRule('sanitizedTable', {
    filter: 'table',
    replacement: (_content, node) => `\n\n${sanitizedTableHtml(node)}\n\n`,
  });
  service.remove(NON_CONTENT_TAGS);
  service.remove(node => {
    return isBottomBar(node as Element);
  });

  return service;
}
