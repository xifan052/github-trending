const fetch = require("node-fetch");
const crypto = require("crypto");
const puppeteer = require("puppeteer");
require("dotenv").config();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const BAIDU_APP_ID = process.env.BAIDU_APP_ID;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const SKIP_HOLIDAYS = process.env.SKIP_HOLIDAYS === 'true'; // 新增环境变量

// 检查是否为节假日
async function isHoliday() {
  if (!SKIP_HOLIDAYS) return false;
  
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const date = `${year}${month}${day}`;
    
    // 使用节假日 API
    const response = await fetch(`https://timor.tech/api/holiday/info/${date}`);
    const data = await response.json();
    
    // 0 工作日, 1 周末, 2 节假日
    return data.type.type !== 0;
  } catch (error) {
    log(`检查节假日失败: ${error.message}`, "error");
    return false;
  }
}

// 日志函数
function log(message, type = "info") {
  const timestamp = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const prefix = type === "error" ? "❌" : type === "success" ? "✅" : "ℹ️";
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

// 翻译功能
async function translateText(text) {
  if (!text || text === "No description provided.") {
    return "";
  }
  try {
    log(`开始翻译: ${text.substring(0, 30)}...`);
    const salt = Date.now();
    const sign = crypto
      .createHash("md5")
      .update(BAIDU_APP_ID + text + salt + BAIDU_SECRET_KEY)
      .digest("hex");

    const url = `https://fanyi-api.baidu.com/api/trans/vip/translate?q=${encodeURIComponent(
      text
    )}&from=en&to=zh&appid=${BAIDU_APP_ID}&salt=${salt}&sign=${sign}`;

    const response = await fetch(url);
    const result = await response.json();

    if (result.error_code) {
      throw new Error(`翻译API错误: ${result.error_msg}`);
    }

    const translated = result.trans_result[0].dst;
    log(`翻译完成: ${translated.substring(0, 30)}...`, "success");
    return translated;
  } catch (error) {
    log(`翻译失败: ${error.message}`, "error");
    return "";
  }
}

// 获取 GitHub Trending 数据
async function getTrendingRepos(since = "daily") {
  log("启动浏览器...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    log("创建新页面...");
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    log("设置请求拦截...");
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    log(`访问GitHub Trending页面 (${since})...`);
    await page.goto(`https://github.com/trending?since=${since}`, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });

    log("开始解析页面数据...");
    const repos = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("article.Box-row"));
      return items.slice(0, 10).map((el) => {
        const title =
          el.querySelector("h2")?.textContent?.trim().replace(/\s+/g, "") || "";
        const desc =
          el.querySelector("p")?.textContent?.trim() ||
          "No description provided.";
        const stars =
          el.querySelector('a[href*="stargazers"]')?.textContent?.trim() || "0";
        const todayStars =
          el
            .querySelector('span[class*="d-inline-block float-sm-right"]')
            ?.textContent?.trim() || "0";
        const language =
          el
            .querySelector('span[itemprop="programmingLanguage"]')
            ?.textContent?.trim() || "";
        const forks =
          el.querySelector('a[href*="network/members"]')?.textContent?.trim() ||
          "0";
        return {
          title,
          desc,
          stars,
          todayStars,
          language,
          forks,
          href: `https://github.com/${title}`,
        };
      });
    });
    log(`成功获取 ${repos.length} 个热门项目`, "success");

    const formattedRepos = [];
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i];
      const todayStars = repo.todayStars?.match(/[\d,]+/)[0];
      log(`处理第 ${i + 1} 个项目: ${repo.title}`);
      const translatedDesc = await translateText(repo.desc);
      formattedRepos.push(`### ${i + 1}. [${repo.title}](${repo.href})
 📊 项目信息
 - 💻 语言: ${repo.language || "N/A"} | ⭐ star数: ${repo.stars} | 新增: ${todayStars}
 📝 描述
 - ${
   repo.desc !== "No description provided."
     ? `${repo.desc}\n - ${translatedDesc}`
     : "暂无项目描述"
 }
 ---`);
    }

    return formattedRepos.join("\n");
  } catch (error) {
    log(`获取GitHub热门项目失败: ${error.message}`, "error");
    throw error;
  } finally {
    log("关闭浏览器...");
    await browser.close();
  }
}

// 发送到企业微信
async function sendToWechat(text, title) {
  try {
    log("准备发送消息到企业微信...");
    const now = new Date();
    const formattedDate = now.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const data = {
      msgtype: "markdown",
      markdown: {
        content: `# 🌟 ${title} (${formattedDate})

${text}

> 数据来源: [GitHub Trending](https://github.com/trending)

[daily](https://github.com/trending?since=daily) | [weekly](https://github.com/trending?since=weekly) | [monthly](https://github.com/trending?since=monthly)`,
      },
    };

    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    log("response-->", response)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    log("消息发送成功", "success");
  } catch (error) {
    log(`发送消息失败: ${error.message}`, "error");
    throw error;
  }
}

module.exports = {
  log,
  translateText,
  getTrendingRepos,
  sendToWechat,
  isHoliday,
}; 
