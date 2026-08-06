import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('~/utils/comment', () => ({
  extractCommentId: () => null,
}));

type HtmlUtils = typeof import('../shared/utils/html');
type AboutBizUtils = typeof import('../server/api/public/beta/aboutbiz.get');

let htmlUtils: HtmlUtils;
let aboutBizUtils: AboutBizUtils;

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
  htmlUtils = await import('../shared/utils/html');
  aboutBizUtils = await import('../server/api/public/beta/aboutbiz.get');
});

describe('safe WeChat script parsing', () => {
  it('extracts current and legacy account nickname forms without executing scripts', () => {
    expect(htmlUtils.extractWechatAccountName('<script>var nickname = htmlDecode("A&amp;B")</script>')).toBe('A&B');
    expect(htmlUtils.extractWechatAccountName("<script>var nickname = '新游观察'</script>")).toBe('新游观察');
    expect(htmlUtils.extractWechatAccountName('<span class="account_nickname_inner">旧结构账号</span>')).toBe(
      '旧结构账号'
    );
    expect(
      htmlUtils.extractWechatAccountName(`<script>
        // nickname = '注释伪账号'
        const example = "nickname = '字符串伪账号'";
        function fallback(nickname = '参数伪账号') { return nickname; }
        const arrow = (nickname = '箭头参数伪账号') => nickname;
        var nickname = htmlDecode('真实&amp;账号');
      </script>`)
    ).toBe('真实&账号');

    vi.stubGlobal('__wechatNicknameProbe', false);
    const malicious = htmlUtils.extractWechatAccountName(`<script>
      var nickname = (() => { globalThis.__wechatNicknameProbe = true; return 'bad'; })()
    </script><span class="wx_follow_nickname">安全兜底</span>`);
    expect(malicious).toBe('安全兜底');
    expect((globalThis as Record<string, unknown>).__wechatNicknameProbe).toBe(false);
  });

  it('parses the whitelisted cgiDataNew expression without running trailing code', async () => {
    vi.stubGlobal('__wechatSecurityProbe', false);
    const html = `<script type="text/javascript" h5only>
      window.cgiDataNew = {
        bizuin: JsDecode('MzExample'),
        title: JsDecode('A\\x26B'),
        user_info: { appmsg_bar_data: { read_num: '42' * 1, like_count: '0' * 1 } }
      };
      globalThis.__wechatSecurityProbe = true;
    </script>`;

    const result = await htmlUtils.parseCgiDataNew(html);
    expect(result).toMatchObject({
      bizuin: 'MzExample',
      title: 'A&B',
      user_info: { appmsg_bar_data: { read_num: 42, like_count: 0 } },
    });
    expect((globalThis as Record<string, unknown>).__wechatSecurityProbe).toBe(false);
  });

  it('retains literal metadata extraction from mixed HTML sources', () => {
    const value = htmlUtils.extractWechatScriptAssignment(
      '<!doctype html><html><script>window.ip_wording = { countryName: "中国" };</script></html>',
      'window.ip_wording'
    );
    expect(value).toEqual({ countryName: '中国' });
  });

  it('rejects calls and prototype-related keys outside the whitelist', async () => {
    const call = await htmlUtils.parseCgiDataNew(
      '<script>window.cgiDataNew = { danger: (() => globalThis.__wechatSecurityProbe = true)() };</script>'
    );
    const prototypeKey = await htmlUtils.parseCgiDataNew(
      '<script>window.cgiDataNew = { __proto__: { polluted: true } };</script>'
    );
    expect(call).toBeNull();
    expect(prototypeKey).toBeNull();
    expect((globalThis as Record<string, unknown>).__wechatSecurityProbe).toBe(false);
  });

  it('parses a credential-bearing repository sample', async () => {
    const sample = readFileSync(resolve('samples/文本分享/c03.html'), 'utf8');
    const result = await htmlUtils.parseCgiDataNew(sample);
    const userInfo = result?.user_info as { appmsg_bar_data: { read_num: number; like_count: number } } | undefined;
    expect(result).not.toBeNull();
    expect(userInfo?.appmsg_bar_data.read_num).toBe(9326);
    expect(userInfo?.appmsg_bar_data.like_count).toBeTypeOf('number');
  });

  it('extracts aboutbiz script data as whitelisted records', () => {
    const sample = readFileSync(resolve('samples/aboutbiz/biz-MjM5ODMxNzE2NQ==.html'), 'utf8');
    const result = aboutBizUtils.extractAboutBizScriptData(sample);
    expect(result.cgiData).not.toBeNull();
    expect(result.ip_wording).toMatchObject({ countryName: '中国', provinceName: '上海' });
    expect(result.auth_3rd_list).toHaveLength(2);
    expect(result.auth_3rd_list[0]).toMatchObject({ principal: '秀米' });
    expect(result.auth_3rd_list[0]).not.toHaveProperty('__proto__');
  });

  it('removes active content and unsafe URL attributes from exported HTML', () => {
    const output = htmlUtils.sanitizeWechatHtmlDocument(`<!doctype html><html><body>
      <script>globalThis.__wechatSecurityProbe = true</script>
      <a href="java\nscript:alert(1)" onclick="alert(1)">bad</a>
      <img src="https://mmbiz.qpic.cn/safe.png" onerror="alert(1)">
      <iframe src="https://v.qq.com/player" srcdoc="<script>alert(1)</script>" allow="camera"></iframe>
    </body></html>`);
    expect(output).not.toMatch(/<script|onclick|onerror|srcdoc|javascript:|allow="camera"/i);
    expect(output).toContain('src="https://mmbiz.qpic.cn/safe.png"');
    expect(output).toMatch(/<iframe[^>]+sandbox=""[^>]+referrerpolicy="no-referrer"/i);
  });

  it('contains no dynamic script execution path', () => {
    const htmlSource = readFileSync(resolve('shared/utils/html.ts'), 'utf8');
    const aboutSource = readFileSync(resolve('server/api/public/beta/aboutbiz.get.ts'), 'utf8');
    expect(`${htmlSource}\n${aboutSource}`).not.toMatch(/\beval\s*\(|new Function|eval-js-code/);
  });

  it('renders API text samples and external titles as escaped text', () => {
    const codeSegment = readFileSync(resolve('components/api/CodeSegment.vue'), 'utf8');
    const singlePage = readFileSync(resolve('pages/dashboard/single.vue'), 'utf8');
    const discussPage = readFileSync(resolve('pages/dev/discuss.vue'), 'utf8');

    expect(codeSegment).toContain('escapeHtml(code.value)');
    expect(singlePage).not.toMatch(/v-html="item\.title"/);
    expect(discussPage).not.toMatch(/v-html="comment\.content"/);
  });
});
