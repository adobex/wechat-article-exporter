import { afterEach, describe, expect, it } from 'vitest';
import {
  clearProfileCredentials,
  getProfileCredential,
  listProfileCredentialStatus,
  storeProfileCredentialSnapshot,
} from '../server/utils/profile-credential-store';
import { normalizeProfileGetMsgResponse, profileArticleToAppMsgEx } from '../shared/utils/profile-ext';
import type { ProfileGetMsgResponse } from '../types/profile_getmsg';

function response(overrides: Partial<ProfileGetMsgResponse> = {}): ProfileGetMsgResponse {
  return {
    ret: 0,
    errmsg: 'ok',
    can_msg_continue: 1,
    msg_count: 1,
    next_offset: 10,
    real_type: 0,
    use_video_tab: 0,
    video_count: 0,
    general_msg_list: JSON.stringify({
      list: [
        {
          comm_msg_info: { content: '', datetime: 1_700_000_000, fakeid: 'biz', id: 123, status: 0, type: 49 },
          app_msg_ext_info: {
            author: '作者',
            content_url: 'http://mp.weixin.qq.com/s?__biz=biz&amp;mid=100&amp;idx=1&amp;sn=main#wechat_redirect',
            cover: 'cover',
            del_flag: 0,
            digest: '摘要',
            item_show_type: 0,
            title: '主文章',
            multi_app_msg_item_list: [
              {
                author: '作者',
                content_url: 'https://mp.weixin.qq.com/s?__biz=biz&amp;mid=100&amp;idx=2&amp;sn=child',
                cover: '',
                del_flag: 0,
                digest: '',
                item_show_type: 0,
                title: '子文章',
              },
              {
                content_url: 'https://mp.weixin.qq.com/s?mid=100&amp;idx=3',
                del_flag: 4,
                title: '已删除',
              },
              {
                content_url: 'https://evil.example/s?mid=100&amp;idx=4',
                del_flag: 0,
                title: '越界链接',
              },
            ],
          },
        },
      ],
    }),
    ...overrides,
  };
}

describe('profile_ext response normalization', () => {
  it('expands multi-article messages and filters deleted or non-WeChat links', () => {
    const page = normalizeProfileGetMsgResponse(response());
    expect(page.base_resp.ret).toBe(0);
    expect(page.can_continue).toBe(true);
    expect(page.next_offset).toBe(10);
    expect(page.articles.map(article => article.title)).toEqual(['主文章', '子文章']);
    expect(page.articles.map(article => article.aid)).toEqual(['100_1', '100_2']);
    expect(page.articles[0].link).toMatch(/^https:\/\/mp\.weixin\.qq\.com\/s\?/);
    expect(page.articles[0].link).not.toContain('&amp;');
  });

  it('returns a normalized error page without parsing malformed article data', () => {
    const page = normalizeProfileGetMsgResponse(
      response({ ret: 200013, errmsg: 'freq control', general_msg_list: '' })
    );
    expect(page.base_resp).toEqual({ ret: 200013, err_msg: 'freq control' });
    expect(page.articles).toEqual([]);
  });

  it('converts profile articles into complete cache-compatible article records', () => {
    const page = normalizeProfileGetMsgResponse(response());
    const article = profileArticleToAppMsgEx(page.articles[0]);

    expect(article).toMatchObject({
      aid: '100_1',
      appmsgid: 100,
      itemidx: 1,
      title: '主文章',
      album_id: '',
      appmsg_album_infos: [],
      is_deleted: false,
    });
    expect(article.link).toMatch(/^https:\/\/mp\.weixin\.qq\.com\/s\?/);
  });

  it('fails closed when profile pagination does not move forward', () => {
    const repeated = normalizeProfileGetMsgResponse(response({ next_offset: 10 }), 10);
    expect(repeated.base_resp).toEqual({ ret: -3, err_msg: 'profile_ext pagination did not advance safely' });
    expect(repeated.can_continue).toBe(false);
    expect(repeated.articles).toEqual([]);

    const oversized = normalizeProfileGetMsgResponse(response({ next_offset: 1_000_001 }), 10);
    expect(oversized.base_resp.ret).toBe(-3);
  });
});

describe('ephemeral profile Credential store', () => {
  afterEach(() => clearProfileCredentials());

  it('keeps fresh secrets in memory but exposes only redacted status metadata', () => {
    const now = Date.UTC(2026, 7, 3, 12, 0, 0);
    const result = storeProfileCredentialSnapshot(
      [
        {
          biz: 'biz-id',
          nickname: '目标账号',
          uin: 'secret-uin',
          key: 'secret-key',
          pass_ticket: 'secret-ticket',
          wap_sid2: 'secret-cookie',
          appmsg_token: 'secret-token',
          cookie: 'wap_sid2=secret-cookie\r\nInjected: value',
          timestamp: now - 1000,
        },
      ],
      now
    );

    expect(result).toEqual({ accepted: 1, rejected: 0, active: 1, applied: true });
    expect(getProfileCredential('biz-id', now)?.cookie).not.toContain('\n');
    const status = JSON.stringify(listProfileCredentialStatus(now));
    expect(status).toContain('biz-id');
    expect(status).not.toMatch(/secret-key|secret-ticket|secret-cookie|secret-token|secret-uin/);
    expect(getProfileCredential('biz-id', now + 26 * 60 * 1000)).toBeNull();
  });

  it('rejects expired, incomplete, and oversized snapshots', () => {
    const now = Date.UTC(2026, 7, 3, 12, 0, 0);
    const result = storeProfileCredentialSnapshot(
      [
        { biz: 'expired', uin: 'u', key: 'k', pass_ticket: 'p', wap_sid2: 'w', timestamp: now - 30 * 60 * 1000 },
        { biz: 'incomplete', timestamp: now },
      ],
      now
    );
    expect(result).toEqual({ accepted: 0, rejected: 2, active: 0, applied: true });
  });

  it('replaces the complete snapshot and lets an empty snapshot revoke cached secrets', () => {
    const now = Date.UTC(2026, 7, 3, 12, 0, 0);
    const credential = {
      biz: 'biz-id',
      uin: 'uin',
      key: 'key',
      pass_ticket: 'ticket',
      wap_sid2: 'sid',
      timestamp: now,
    };

    expect(storeProfileCredentialSnapshot([credential], now).active).toBe(1);
    expect(storeProfileCredentialSnapshot([], now)).toEqual({
      accepted: 0,
      rejected: 0,
      active: 0,
      applied: true,
    });
    expect(getProfileCredential('biz-id', now)).toBeNull();

    storeProfileCredentialSnapshot([credential], now);
    expect(
      storeProfileCredentialSnapshot(
        Array.from({ length: 101 }, () => credential),
        now
      )
    ).toEqual({
      accepted: 0,
      rejected: 101,
      active: 1,
      applied: false,
    });
    expect(getProfileCredential('biz-id', now)).not.toBeNull();
  });
});
