# GitHub Trending推送

获取GitHub Trending并推送到企业微信。

- 基于百度翻译api批量翻译仓库描述，推送中英文
- GitHub Actions推送企业微信，每日推送一次，每周推送一次，每月推送一次

## 推送规则

- 日报：每天北京时间 08:00 推送，`SKIP_HOLIDAYS=true` 时跳过节假日和周末
- 周报：本周(周一~周日)最后一个工作日推送，节假日/调休自动顺延
- 月报：本月最后一个工作日推送，月末遇节假日/周末自动提前
- 节假日数据来自 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（国务院公告，含调休安排）
- 消息超过企微单条 4096 字节上限时自动分条发送，发送结果以企微接口 `errcode` 为准
- 任意任务失败时会向企微发送失败告警（附 Actions 运行链接）
- 手动触发(workflow_dispatch)会跳过节假日/最后工作日判断，便于调试或补发；周报/月报工作流可选择只推 weekly / monthly
- Keepalive 工作流：仓库连续 60 天无提交时 GitHub 会自动停用定时任务，超过 45 天无提交时自动推送空提交保活

## 配置

## 本地运行

1. 复制`.env.example`为`.env`，填入配置：

```env
WEBHOOK_URL="你的企业微信机器人webhook地址"
BAIDU_APP_ID="你的百度翻译API App ID"
BAIDU_SECRET_KEY="你的百度翻译API密钥"
SKIP_HOLIDAYS="true" # 是否跳过节假日推送
```

```bash
# 也可以直接 node src/index.js daily|weekly|monthly
# 运行每日推送
npm run server

# 运行每周推送
npm run server:weekly

# 运行每月推送
npm run server:monthly
```

本地模拟手动触发(跳过节假日/最后工作日判断)：

```bash
GITHUB_EVENT_NAME=workflow_dispatch npm run server
```

运行测试：

```bash
npm test
```

## GitHub Action

 在 GitHub 仓库的 Secrets 中添加相同的环境变量（用于 GitHub Actions）
