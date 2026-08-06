import { parse, parseExpressionAt } from 'acorn';
import * as cheerio from 'cheerio';
import { extractCommentId } from '~/utils/comment';

const ACTIVE_CONTENT_ELEMENTS = 'script, object, embed, base, meta[http-equiv="refresh" i]';
const URL_ATTRIBUTES = new Set(['action', 'formaction', 'href', 'poster', 'src', 'xlink:href']);

function compactHtmlUrl(value: string): string {
  return Array.from(value, character => (character.charCodeAt(0) <= 0x20 ? '' : character)).join('');
}

function isUnsafeHtmlUrl(tagName: string, attributeName: string, value: string): boolean {
  const compact = compactHtmlUrl(value).toLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:')) return true;
  if (!compact.startsWith('data:')) return false;
  return !(tagName === 'img' && attributeName === 'src' && compact.startsWith('data:image/'));
}

function sanitizeLoadedHtml($: cheerio.CheerioAPI): void {
  $(ACTIVE_CONTENT_ELEMENTS).remove();
  $('*').each((_index, element) => {
    const node = $(element);
    const tagName = String((element as { name?: string }).name || '').toLowerCase();
    for (const [rawName, value] of Object.entries((element as { attribs?: Record<string, string> }).attribs || {})) {
      const name = rawName.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') {
        node.removeAttr(rawName);
        continue;
      }
      if (URL_ATTRIBUTES.has(name) && isUnsafeHtmlUrl(tagName, name, value)) {
        node.removeAttr(rawName);
        continue;
      }
      if (name === 'srcset' && /(?:javascript|vbscript|data):/i.test(compactHtmlUrl(value))) {
        node.removeAttr(rawName);
      }
    }

    if (tagName === 'iframe') {
      node.attr('sandbox', '');
      node.attr('referrerpolicy', 'no-referrer');
      node.removeAttr('allow');
    }
  });
}

export function sanitizeWechatHtmlDocument(rawHtml: string): string {
  const $ = cheerio.load(rawHtml);
  sanitizeLoadedHtml($);
  return `<!DOCTYPE html>\n${$.html()}`;
}

/**
 * 处理文章的 html 内容
 * @description 采用 cheerio 库解析并修改 html 内容
 * @param rawHTML 公众号文章的原始 html
 * @param format 要处理的格式(默认html)
 * @remarks 服务端工具函数
 */
export function normalizeHtml(rawHTML: string, format: 'html' | 'text' = 'html'): string {
  const $ = cheerio.load(rawHTML);
  const $jsArticleContent = $('#js_article');

  // #js_content 默认是不可见的(通过js修改为可见)，需要移除该样式
  $jsArticleContent.find('#js_content').removeAttr('style');

  // 删除无用dom元素
  $jsArticleContent.find('#js_top_ad_area').remove();
  $jsArticleContent.find('#js_tags_preview_toast').remove();
  $jsArticleContent.find('#content_bottom_area').remove();

  // 删除所有 script 标签（在 #js_article 上下文中）
  $jsArticleContent.find('script').remove();

  $jsArticleContent.find('#js_pc_qr_code').remove();
  $jsArticleContent.find('#wx_stream_article_slide_tip').remove();

  // 处理图片懒加载（全局处理所有 img）
  $('img').each((_i, el) => {
    const $img = $(el);
    const imgUrl = $img.attr('src') || $img.attr('data-src');
    if (imgUrl) {
      $img.attr('src', imgUrl);
    }
  });

  if (format === 'text') {
    // 获取纯文本内容
    const text = $jsArticleContent.text().trim().replace(/\n+/g, '\n').replace(/ +/g, ' ');
    // 分割成行
    const lines = text.split('\n');
    // 过滤掉全空白行（^\s*$ 表示行首到行尾全是空白字符）
    const filteredLines = lines.filter(line => !/^\s*$/.test(line));

    // 重新连接行
    return filteredLines.join('\n');
  } else if (format === 'html') {
    // 获取修改后的 HTML
    const bodyCls = $('body').attr('class');
    const pageContentHTML = $('<div>').append($jsArticleContent.clone()).html();
    return sanitizeWechatHtmlDocument(`<!DOCTYPE html>
  <html lang="zh_CN">
  <head>
      <meta charset="utf-8">
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=0,viewport-fit=cover">
      <meta name="referrer" content="no-referrer">
      <style>
          #js_row_immersive_stream_wrap {
              max-width: 667px;
              margin: 0 auto;
          }
          #js_row_immersive_stream_wrap .wx_follow_avatar_pic {
            display: block;
            margin: 0 auto;
          }
          #page-content,
          #js_article_bottom_bar,
          .__page_content__ {
              max-width: 667px;
              margin: 0 auto;
          }
          img {
              max-width: 100%;
          }
          .sns_opr_btn::before {
              width: 16px;
              height: 16px;
              margin-right: 3px;
          }
      </style>
  </head>
  <body class="${bodyCls}">
  ${pageContentHTML}
  </body>
  </html>
    `);
  } else {
    throw new Error(`format not supported: ${format}`);
  }
}

/**
 * 验证文章的 html 内容是否下载成功，以及提取出 commentID
 * @param html
 * @return [状态，commentID/msg] 二元组
 */
export function validateHTMLContent(html: string): ['Success' | 'Deleted' | 'Exception' | 'Error', string | null] {
  const $ = cheerio.load(html);
  const $jsArticle = $('#js_article');
  const $weuiMsg = $('.weui-msg');
  const $msgBlock = $('.mesg-block');

  if ($jsArticle.length === 1) {
    // 成功
    const commentID = extractCommentId(html);
    return ['Success', commentID];
  } else if ($weuiMsg.length === 1) {
    // 失败，需要进一步判断失败类型
    const msg = $('.weui-msg .weui-msg__title').text().trim().replace(/\n+/g, '').replace(/ +/g, ' ');
    if (msg && ['The content has been deleted by the author.', '该内容已被发布者删除'].includes(msg)) {
      return ['Deleted', null];
    } else {
      return ['Exception', msg];
    }
  } else if ($msgBlock.length === 1) {
    const msg = $msgBlock.text().trim().replace(/\n+/g, '').replace(/ +/g, ' ');
    return ['Exception', msg];
  } else {
    return ['Error', null];
  }
}

type ScriptPrimitive = string | number | boolean | null | undefined;
export type SafeScriptValue = ScriptPrimitive | SafeScriptValue[] | SafeScriptRecord;
export interface SafeScriptRecord {
  [key: string]: SafeScriptValue;
}

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface ParsedScriptValue {
  value: SafeScriptValue;
  end: number;
}

const MAX_SCRIPT_LENGTH = 8 * 1024 * 1024;
const MAX_AST_DEPTH = 128;
const MAX_AST_NODES = 300_000;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function decodeWechatString(value: string): string {
  return value
    .replace(/\\x22/g, '"')
    .replace(/\\x26/g, '&')
    .replace(/\\x27/g, "'")
    .replace(/\\x3c/gi, '<')
    .replace(/\\x3e/gi, '>')
    .replace(/\\x0a/gi, '\n');
}

function decodeWechatHtmlString(value: string): string {
  return cheerio.load(`<body>${value}</body>`)('body').text();
}

function readObjectKey(node: AstNode): string {
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    return node.name;
  }
  if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) {
    return String(node.value);
  }
  throw new Error('Unsupported object key');
}

function interpretScriptNode(node: AstNode, state: { nodes: number }, depth = 0): SafeScriptValue {
  state.nodes += 1;
  if (depth > MAX_AST_DEPTH || state.nodes > MAX_AST_NODES) {
    throw new Error('Script literal exceeds parser limits');
  }

  if (node.type === 'Literal') {
    const value = node.value;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      return value as ScriptPrimitive;
    }
    throw new Error('Unsupported literal');
  }

  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return undefined;
    throw new Error('Unsupported identifier');
  }

  if (node.type === 'ArrayExpression') {
    const elements = node.elements as Array<AstNode | null>;
    if (elements.some(element => element === null)) {
      throw new Error('Sparse arrays are not supported');
    }
    return elements.map(element => {
      if (!element) throw new Error('Sparse arrays are not supported');
      return interpretScriptNode(element, state, depth + 1);
    });
  }

  if (node.type === 'ObjectExpression') {
    const result: Record<string, SafeScriptValue> = {};
    for (const propertyNode of node.properties as AstNode[]) {
      if (propertyNode.type !== 'Property') throw new Error('Object spreads are not supported');
      if (
        propertyNode.computed === true ||
        propertyNode.method === true ||
        propertyNode.shorthand === true ||
        propertyNode.kind !== 'init'
      ) {
        throw new Error('Unsupported object property');
      }

      const key = readObjectKey(propertyNode.key as AstNode);
      if (FORBIDDEN_OBJECT_KEYS.has(key) || Object.hasOwn(result, key)) {
        throw new Error('Unsafe or duplicate object key');
      }
      result[key] = interpretScriptNode(propertyNode.value as AstNode, state, depth + 1);
    }
    return result;
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee as AstNode;
    const args = node.arguments as AstNode[];
    if (
      callee.type !== 'Identifier' ||
      !['JsDecode', 'htmlDecode'].includes(String(callee.name)) ||
      args.length !== 1
    ) {
      throw new Error('Unsupported function call');
    }
    const value = interpretScriptNode(args[0], state, depth + 1);
    if (typeof value !== 'string') throw new Error(`${String(callee.name)} only accepts a string literal`);
    return callee.name === 'htmlDecode' ? decodeWechatHtmlString(value) : decodeWechatString(value);
  }

  if (node.type === 'BinaryExpression') {
    if (node.operator !== '*') throw new Error('Unsupported binary expression');
    const left = interpretScriptNode(node.left as AstNode, state, depth + 1);
    const right = interpretScriptNode(node.right as AstNode, state, depth + 1);
    if (!['string', 'number'].includes(typeof left) || right !== 1) {
      throw new Error('Only numeric coercion by multiplication with 1 is supported');
    }
    return Number(left);
  }

  if (node.type === 'UnaryExpression') {
    const value = interpretScriptNode(node.argument as AstNode, state, depth + 1);
    if (typeof value !== 'number' || !['+', '-'].includes(String(node.operator))) {
      throw new Error('Unsupported unary expression');
    }
    return node.operator === '-' ? -value : value;
  }

  throw new Error(`Unsupported script node: ${node.type}`);
}

function parseScriptValueAt(source: string, start: number): ParsedScriptValue {
  if (source.length > MAX_SCRIPT_LENGTH) throw new Error('Script is too large');
  const node = parseExpressionAt(source, start, { ecmaVersion: 'latest' }) as AstNode;
  return {
    value: interpretScriptNode(node, { nodes: 0 }),
    end: node.end,
  };
}

function skipScriptTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const lineEnd = source.indexOf('\n', cursor + 2);
      return lineEnd === -1 ? source.length : skipScriptTrivia(source, lineEnd + 1);
    }
    if (source.startsWith('/*', cursor)) {
      const commentEnd = source.indexOf('*/', cursor + 2);
      if (commentEnd === -1) return source.length;
      cursor = commentEnd + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function hasMarkerBoundary(source: string, marker: string, index: number): boolean {
  const before = source[index - 1] || '';
  const after = source[index + marker.length] || '';
  return !/[\w$]/.test(before) && !/[\w$]/.test(after);
}

export function extractWechatScriptAssignment(source: string, marker: string): SafeScriptValue | null {
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const markerIndex = source.indexOf(marker, searchFrom);
    if (markerIndex === -1) return null;
    searchFrom = markerIndex + marker.length;
    if (!hasMarkerBoundary(source, marker, markerIndex)) continue;

    let cursor = skipScriptTrivia(source, searchFrom);
    if (source[cursor] !== '=' || ['=', '>'].includes(source[cursor + 1] || '')) continue;
    cursor = skipScriptTrivia(source, cursor + 1);

    try {
      return parseScriptValueAt(source, cursor).value;
    } catch {
      // Continue looking in case the marker appeared in a comment or unrelated statement.
    }
  }
  return null;
}

function isNicknameAssignmentTarget(node: AstNode): boolean {
  if (node.type === 'Identifier') return node.name === 'nickname';
  if (node.type !== 'MemberExpression' || node.computed === true) return false;
  const object = node.object as AstNode;
  const property = node.property as AstNode;
  return (
    object.type === 'Identifier' &&
    ['window', 'globalThis'].includes(String(object.name)) &&
    property.type === 'Identifier' &&
    property.name === 'nickname'
  );
}

function extractTopLevelNicknameAssignment(source: string): SafeScriptValue | null {
  if (source.length > MAX_SCRIPT_LENGTH) return null;
  try {
    const program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
    }) as unknown as AstNode;
    for (const statement of program.body as AstNode[]) {
      if (statement.type === 'VariableDeclaration') {
        for (const declaration of statement.declarations as AstNode[]) {
          const identifier = declaration.id as AstNode;
          const initializer = declaration.init as AstNode | null;
          if (identifier?.type === 'Identifier' && identifier.name === 'nickname' && initializer) {
            return interpretScriptNode(initializer, { nodes: 0 });
          }
        }
      }

      if (statement.type === 'ExpressionStatement') {
        const expression = statement.expression as AstNode;
        if (
          expression?.type === 'AssignmentExpression' &&
          expression.operator === '=' &&
          isNicknameAssignmentTarget(expression.left as AstNode)
        ) {
          return interpretScriptNode(expression.right as AstNode, { nodes: 0 });
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function extractWechatScriptCallArguments(source: string, marker: string): SafeScriptValue[] {
  const values: SafeScriptValue[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const markerIndex = source.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;
    searchFrom = markerIndex + marker.length;
    if (!hasMarkerBoundary(source, marker, markerIndex)) continue;

    let cursor = skipScriptTrivia(source, searchFrom);
    if (source[cursor] !== '(') continue;
    cursor = skipScriptTrivia(source, cursor + 1);

    try {
      const parsed = parseScriptValueAt(source, cursor);
      const closeParen = skipScriptTrivia(source, parsed.end);
      if (source[closeParen] !== ')') continue;
      values.push(parsed.value);
      searchFrom = closeParen + 1;
    } catch {
      // Ignore non-literal calls and continue scanning the script.
    }
  }
  return values;
}

/**
 * Extract the account nickname from current and legacy WeChat article markup.
 */
export function extractWechatAccountName(rawHtml: string): string {
  const $ = cheerio.load(rawHtml);
  for (const script of $('script').toArray()) {
    const source = $(script).html() || '';
    if (!source.includes('nickname')) continue;
    const value = extractTopLevelNicknameAssignment(source);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return $('.wx_follow_nickname, .account_nickname_inner').first().text().trim();
}

/**
 * 从 html 中提取 cgiDataNew 对象
 * @param html 文章的完整 html 内容
 * @return window.cgiDataNew 对象，解析失败时返回 null
 */
export async function parseCgiDataNew(html: string): Promise<SafeScriptRecord | null> {
  const $ = cheerio.load(html);
  for (const script of $('script').toArray()) {
    const source = $(script).html() || '';
    if (!source.includes('window.cgiDataNew')) continue;

    const value = extractWechatScriptAssignment(source, 'window.cgiDataNew');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as SafeScriptRecord;
    }
  }
  return null;
}
