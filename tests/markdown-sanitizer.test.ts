import { describe, expect, it } from 'vitest';
import { createTurndownService } from '../shared/utils/markdown';

describe('shared Markdown sanitizer', () => {
  it('removes document CSS and WeChat bottom bars while preserving article content and tables', () => {
    const markdown = createTurndownService().turndown(`<!doctype html><html><head>
      <title>noise title</title><style>body { color: red; }</style>
    </head><body>
      <article><h1>正文标题</h1><p>正文内容</p><table><tbody><tr><td>单元格</td></tr></tbody></table></article>
      <div class="layout __bottom-bar__"><img src="data:image/svg+xml;base64,NOISE">阅读与分享</div>
      <div id="content_bottom_area">留言操作</div>
      <div id="js_article_bottom_bar">推荐操作</div>
    </body></html>`);

    expect(markdown).toContain('# 正文标题');
    expect(markdown).toContain('正文内容');
    expect(markdown).toContain('<table>');
    expect(markdown).toContain('单元格');
    expect(markdown).not.toMatch(/noise title|body \{|data:image\/svg|阅读与分享|留言操作|推荐操作/);
  });

  it('uses the same stable Markdown options for all callers', () => {
    const markdown = createTurndownService().turndown('<ul><li>列表</li></ul><p><em>强调</em></p>');
    expect(markdown).toContain('-   列表');
    expect(markdown).toContain('*强调*');
  });

  it('sanitizes raw HTML tables before preserving them', () => {
    const markdown =
      createTurndownService().turndown(`<table onclick="steal()" style="background:url(https://tracker.test)">
      <tbody><tr><td onmouseover="steal()">
        安全文本<script>steal()</script>
        <img src="javascript:steal()" onerror="steal()" alt="封面">
        <a href="javascript:steal()">链接</a>
        <div class="__bottom-bar__">底栏</div>
      </td></tr></tbody>
    </table>`);

    expect(markdown).toContain('<table>');
    expect(markdown).toContain('安全文本');
    expect(markdown).toContain('alt="封面"');
    expect(markdown).not.toMatch(/steal|javascript:|onerror|onclick|onmouseover|style=|tracker|底栏/);
  });

  it('preserves safe indexed and base64 table images', () => {
    const markdown = createTurndownService().turndown(`<table><tbody><tr><td>
      <img src="images/001.png" alt="indexed">
      <img src="../images/002.png" alt="parent">
      <img src="data:image/png;base64,iVBORw0KGgo=" alt="base64">
      <img src="data:image/svg+xml;base64,PHN2Zz4=" alt="active-svg">
      <a href="./details/page.html">详情</a>
    </td></tr></tbody></table>`);

    expect(markdown).toContain('src="images/001.png"');
    expect(markdown).toContain('src="../images/002.png"');
    expect(markdown).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(markdown).toContain('href="./details/page.html"');
    expect(markdown).not.toContain('data:image/svg+xml');
  });
});
