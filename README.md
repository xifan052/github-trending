# GitHub Trending推送

获取GitHub Trending并推送到企业微信。

- 基于百度翻译api翻译仓库描述，推送中英文
- GitHub Actions推送企业微信，每日推送一次，每周推送一次，每月推送一次

## 配置

## 本地运行

1. 创建`.env`文件，添加以下配置：

```env
WEBHOOK_URL="你的企业微信机器人webhook地址"
BAIDU_APP_ID="你的百度翻译API App ID"
BAIDU_SECRET_KEY="你的百度翻译API密钥"
```

```bash
# 运行每日推送
npm run server

# 运行每周推送
npm run server:weekly

# 运行每月推送
npm run server:monthly
```

## GitHub Action

 在 GitHub 仓库的 Secrets 中添加相同的环境变量（用于 GitHub Actions）
