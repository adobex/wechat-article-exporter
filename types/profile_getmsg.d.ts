export interface ProfileGetMsgResponse {
  ret: number;
  errmsg: string;
  can_msg_continue: number;
  msg_count: number;
  next_offset: number;
  real_type: number;
  use_video_tab: number;
  video_count: number;
  general_msg_list: string | ProfileGeneralMsgList;
}

export interface ProfileGetMsgAppMsgItem {
  audio_fileid: number;
  author: string;
  content: string;
  content_url: string;
  copyright_stat: number;
  cover: string;
  del_flag: number;
  digest: string;
  duration: number;
  fileid: number;
  item_show_type: number;
  malicious_content_type: number;
  malicious_title_reason_id: number;
  play_url: string;
  source_url: string;
  title: string;
}

export interface ProfileGetMsg_app_msg_ext_info extends ProfileGetMsgAppMsgItem {
  subtype: number;
  is_multi: number;
  multi_app_msg_item_list: app_msg_item[];
}

export interface ProfileGetMsg_comm_msg_info {
  content: string;
  datetime: number;
  fakeid: string;
  id: number;
  status: number;
  type: number;
}

export interface ParsedProfileGetMsg {
  app_msg_ext_info: ProfileGetMsg_app_msg_ext_info;
  comm_msg_info: ProfileGetMsg_comm_msg_info;
}

export interface ProfileGeneralMsgList {
  list: ParsedProfileGetMsg[];
}

export interface ProfileArticle {
  aid: string;
  author_name: string;
  cover: string;
  create_time: number;
  digest: string;
  is_deleted: boolean;
  item_show_type: number;
  itemidx: number;
  link: string;
  title: string;
  update_time: number;
}

export interface ProfileArticlePage {
  source: 'profile_ext';
  base_resp: {
    ret: number;
    err_msg: string;
  };
  articles: ProfileArticle[];
  can_continue: boolean;
  next_offset: number;
  message_count: number;
}

/** @deprecated Use ProfileGetMsgAppMsgItem. */
export type app_msg_item = ProfileGetMsgAppMsgItem;
