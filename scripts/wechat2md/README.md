## wechat2md Scripts

这里收拢的是围绕 `output/WechatArticles` 原始文章导出做二次分析和入库的辅助脚本。

能力契约：

- 输入：`/Users/adobe/Project/output/WechatArticles` 原始导出、article metadata、分析参数和 KB 目标归属。
- 输出：`.local/wechat2md-analysis/` 下的产品/发行商分析、汇总报告和可导入知识库的中间产物。
- 副作用：analysis 只写 `.local/wechat2md-analysis/`；`kb-import/` 会回写 `knowledge-vault`，必须先确认目标 KB 和覆盖范围。
- 验证：先跑小样本 analysis，再检查产物 JSON/Markdown；正式入库前使用 dry-run 或无写入检查确认入口。

## 工作流配置

- `workflows/indienova-steam-incremental.yaml`
  - 同步 `indienova` 标题含 `steam` 的增量文章。
  - 使用 `indienova` 独立账号 lease/state；可与产品账号 workflow 并发，在 `finally` 只释放自己的 lease。
  - 使用持久 high-watermark + 动态有界 overlap，并每 30 天审计到 `2020-01-01`。
  - 固定“轻量版 / Markdown / 保留 CDN 链接”下载配置。
  - 生成本轮 `index.md` 文件清单，并通过必填 `--file-list` + `--confirm` 导入 Steam KB。
  - 记录禁止误用的产品/发行商 OSINT 入库脚本和索引重建边界。
- `workflows/wechat-account-visible-recovery.yaml`
  - 面向任意单个公众号的通用补全正本，输入当前名称、稳定 `biz` 和日期边界，不含账号白名单。
  - `account_resource.mjs` 按稳定 `biz` 派生账号 lease/state；公众号改名不会改变互斥归属，输出目录仍使用校验后的当前名称。
  - 宿主获取顺序固定为普通 Chrome 可见微信读书目录、公开索引、末位完整数据源探针；部分来源永不推进完整同步状态。
  - `visible_catalog_recovery.mjs` 把可见目录快照和逐篇官方证据变成可执行门禁：复核 lease 与 `localhost:3000` 输出根目录，只下载审计确认缺失的文章，生成本轮 `files.json`，备份短链接修复，并在最终缺失、歧义、日期和稳定 URL 冲突全部为 0 后成功退出；同一输入复跑必须是空批次。
- `workflows/wechat-product-accounts-incremental.yaml`
  - 同步 `游戏吗喽说`、`新游观察`、`王董的新游戏` 2025 年以来的未下载文章。
  - 每个公众号使用独立 lease/state；busy 账号单独跳过，其余账号继续，动态 overlap 每 30 天审计到 `2025-01-01`。
  - 固定“轻量版 / Markdown / 保留 CDN 链接”下载配置。
  - manifest-scoped analysis 生成质量报告；import dry-run 生成 SHA256 receipt，confirm 校验 receipt 与质量 hard gate 后再写 `structured/products`。
  - 三个产品账号分别实例化通用补全正本；普通 Chrome 可见微信读书目录是首选获取方式，`appmsgpublish` 和 `profile_ext` 只在当前健康证据允许时作为末位完整性探针。不会启动专用资料目录或其他浏览器，也不使用 PC 微信、系统代理、受信证书、缓存凭据、Cookie 导出或私有列表接口。
  - `weread_reader_url.mjs` 从稳定 `biz` 生成确定的官方阅读页地址。自动任务只操作可见目录：先记录首批条数，再物理滚动目录触发每批 20 篇的懒加载，直到捕获早于日期边界的条目；首批结果不能单独证明扫描完成。按日期/标题逐项打开文章，从已渲染正文的 `srcdoc` 提取官方 `og:url`，再要求原文 `biz`、标题、日期和非空正文全部匹配后下载。微信读书仍可能延迟或漏收，因此只算部分覆盖，不完成审计或推进 high-watermark。
  - `weread_catalog_audit.mjs` 对运行目录中的官方目录快照执行本地完整性门禁。快照必须包含首批条数、滚动次数、最终条数、最旧日期和越过边界的实证；审计分别报告缺文件、重复歧义和日期错误。逐篇打开官方正文后，还要保存标题、正文日期、`og:url`、`biz`、`mid`、`idx` 证据；缺文件补齐后才允许在显式备份目录下分别修复唯一匹配文章的 frontmatter 日期或缺少稳定身份的微信短链接。已存在的稳定身份冲突、跨账号链接和歧义一律停止，不自动覆盖；修复后必须再次审计到日期、URL 缺口和冲突均为 0。
  - 搜狗公开索引仅作微信读书非人工阻塞失败后的降级补充，不承担完整性判断。可信镜像仅在已有精确标题和日期证据时用于单篇恢复，且账号、标题、日期、微信原文链接和非空正文必须全部匹配。

资源级 automation lease：`automation_lease.py acquire/status/renew/heartbeat/release`。公众号 lease 由 owner 校验 heartbeat 续租并保证同账号互斥；续租失败或 heartbeat 达到 12 小时上限时，必须在继续下载、confirm 或状态写入前停止。`localhost:3000` 只在启动转换期间使用共享短 lease，并以 `/api/local/wechat2md/credentials` 的 HTTP 200、`success=true` 和精确 `outputDir` 作为 readiness；只返回首页、production listener 或输出根目录不同的进程不可复用，也不得自动终止或替换。共享登录态的搜索/翻页请求以及会访问微信的 `profile_ext` 备用请求都必须由 `mp_api_request.py` 执行：本地代理从入口开始计算 25 秒预算，若 token/cookie 查询期间客户端已断开则拒绝再发起微信请求，早于 helper 的 30 秒客户端超时；helper 持有 API lease 到响应后 2 秒冷却结束，并在每次请求和 `freq control` 退避前续租。下载和入库不持有这把锁。不同账号的 reconciliation、下载和目标不同的 KB 入库允许并发。`run_artifact.py` 使用完整 UUID 原子预留 run 目录并在碰撞时重试，manifest、analysis 和 receipt 全部从该唯一 `run_id` 派生。

`profile_ext` 备用链路不替代公众号后台登录态。浏览器在 `http://localhost:3000/` 且启用本地输出时，把仍在 25 分钟有效期内的完整 Credential 快照同源同步到服务进程内存；新快照会撤销已缺失账号，单飞队列会补送同步期间出现的更新，状态接口只暴露账号、到期时间与当前输出根目录。分页必须保持 offset 前进、页面签名不重复，并受每账号 500 页硬上限约束。服务重启、到期或未打开过本地 Dashboard 时缓存为空，不能读取浏览器缓存或拼造密钥；自动任务此时只复用已登录且可受控的普通 Chrome 进入微信读书官方可见目录。Chrome 不可用、未登录或出现验证码时停止该账号，不另开浏览器；其他非人工阻塞失败才允许降级到搜狗公开索引。任何部分来源候选都必须回验文章稳定 `biz` 及非空正文；无论是否命中，旧 sync state 都保持不变。

本地 Dashboard 不会控制 Chrome，也不会把部分来源显示成完整同步成功。普通 Chrome 的微信读书可见目录是宿主补全的首选来源；它产生的本地 Markdown 会进入公众号管理的通用刷新输入，但页面只称其为“本地导出”，不会伪造来源。每次刷新先按稳定 `biz` 合并本地记录，再继续有界公开索引；存在旧本地记录不再阻断新文章发现。公开索引对所有公众号统一按当前名称构造单个有界查询，不含账号白名单、猜测别名或三个产品账号的特殊分支。单次网络请求最多等待 15 秒；成功扫描却没有精确时间范围候选时，会自动复核主查询首页一次，并把复核次数显示在结果提示中。只有本地与公开来源都不可用时才把完整数据源放到末位探针。当前名称或历史名称只负责提名候选，真正入库仍要求匹配稳定 `biz`、正整数 `mid + idx` 和有效发布日期；短链接、跨账号记录、缺失身份及无效日期全部跳过。任何本地或公开结果都会把 `completed` 降为 `false`，且不更新完整同步时间；进度列显示“待完整核验”，不再用 100% 暗示完整。网页不会声称自己启动了普通 Chrome；需要新的官方可见目录补全时，由 Codex 宿主任务执行 `workflows/wechat-account-visible-recovery.yaml` 及其中的 `visible_catalog_recovery.mjs`。对齐后再执行一次必须新增 0 篇，并在文章页逐篇核对标题与日期；`wxdown-service` 只是可选 Credential 来源。

目录约定：

- `analysis/`
  - 读取 `/Users/adobe/Project/output/WechatArticles`
  - 产出到 `wechat-article-exporter/.local/wechat2md-analysis/`
- `kb-import/`
  - 读取 `.local/wechat2md-analysis/` 的分析结果
  - 回写 `knowledge-vault`

分析产物目录约定：

- `.local/wechat2md-analysis/products/`
  - `wechat2md-products.json`
  - `wechat2md-products-categorized.json`
  - `wechat2md-multi-pub-unknown.json`
  - `wechat2md-low-products.json`
- `.local/wechat2md-analysis/publisher-analysis/`
  - `_publisher_analysis.json`
  - `_publisher_analysis.md`
  - `_analysis_quality_report.json`
  - `_structured_import_receipt.json`
  - 各公众号子目录下的 `_publisher_analysis.*`
  - `wechat2md-pubs-*.json`
- `.local/wechat2md-analysis/reports/`
  - 汇总型 Markdown 报告

推荐执行顺序：

1. 先读取目标 workflow YAML，以 workflow 中的 manifest、账号范围、日期下限和下载格式为准。
2. 下载完成后生成本轮文件清单，不复制 Markdown 到 staging 目录。
3. 确认本轮 successful downloads 数量等于唯一 `index.md` 路径数量；否则先处理同标题覆盖问题。
4. 对当前 workflow 跑 manifest-scoped analysis dry-run，确认文章数等于 manifest 文件数；全扫必须显式 `--allow-full-scan`。
5. 写入本轮 analysis 输出目录，检查 standalone/embedded quality 均为 `pass`。
6. 入库前跑必填 `--data-json ... --dry-run` 生成 receipt；只有输入哈希、候选摘要、质量状态均匹配且 receipt 未过期时才可 `--confirm`。
7. 同 slug 多来源会合并；publisher conflict 保留为 `needs-review` 且不生成 stable edge。

正式 products 写入由单 writer lock 覆盖“重读现状、receipt 复核、document 提交与 structured build”；并发批次若基线变化会拒绝旧 receipt，重新 dry-run 后再 confirm。写入先全量预检，再在同盘 staging 生成并替换，失败恢复旧 document/runtime。Steam confirm 使用独立 writer lock，不阻塞 products。legacy JSONL/embedding cleanup 也先全量配对校验、同步 staging、持久备份后替换。所有临时 staging 必须在 `finally` 清理；receipt、sync state 和显式 backup 不是 staging，不得删除。

历史兼容脚本（不要作为自动任务默认链路）：

- `analysis/extract-products.py`
- `kb-import/write-known-products.py`
- `kb-import/write-multi-pub-light.py`
- `kb-import/write-single-pub.py`

这些脚本读取静态全量产物，部分源码里保留旧公众号来源文案；用于新 workflow 前必须先改成 current-run manifest 输入，并完成 dry-run 验证。
