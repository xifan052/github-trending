const fetch = require("node-fetch");
const crypto = require("crypto");
const cheerio = require("cheerio");
require("dotenv").config();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const BAIDU_APP_ID = process.env.BAIDU_APP_ID;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const SKIP_HOLIDAYS = process.env.SKIP_HOLIDAYS === "true";

// 企微 markdown 消息单条上限 4096 字节(utf-8)
// 官方文档: https://developer.work.weixin.qq.com/document/path/91712
const WECHAT_MARKDOWN_MAX_BYTES = 4096;
// 内容超长时项目描述的截断长度(字符数)，截断版可让 10 个项目稳定装进单条
const DESC_MAX_CHARS = { en: 100, zh: 50 };

// ---------- 通用工具 ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function byteLength(str) {
  return Buffer.byteLength(str, "utf8");
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

// ---------- 工作日 / 节假日 ----------
// 数据源: NateScarlet/holiday-cn，国务院放假公告(含调休)，托管在 GitHub 上，Actions 访问稳定
const HOLIDAY_CN_BASE =
  "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master";
const holidayCache = new Map(); // year -> Map<"YYYY-MM-DD", isOffDay>

async function getHolidayMap(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);

  const map = new Map();
  try {
    const response = await fetch(`${HOLIDAY_CN_BASE}/${year}.json`);
    if (response.status === 404) {
      // 次年公告一般 11-12 月才发布，未发布时按周末规则判断
      log(`${year} 年节假日安排尚未发布，按周一至周五判断工作日`, "info");
    } else if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    } else {
      const data = await response.json();
      for (const day of data.days || []) {
        map.set(day.date, day.isOffDay);
      }
    }
  } catch (error) {
    log(
      `获取 ${year} 年节假日数据失败: ${error.message}，按周一至周五判断工作日`,
      "error"
    );
  }
  holidayCache.set(year, map);
  return map;
}

// 统一换算成北京时间再取日期，避免 runner 的 UTC 时区与国内日期错位
function toBeijingDateStr(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function weekdayOfDateStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  // 用 UTC 正午构造，保证换算成北京时间后仍是同一天
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

function addDaysDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return toBeijingDateStr(new Date(Date.UTC(y, m - 1, d + days, 12)));
}

// dateStr 格式 "YYYY-MM-DD"：周末默认休息，公告放假日休息，调休上班日(isOffDay=false)上班
async function isWorkdayDateStr(dateStr) {
  const holidays = await getHolidayMap(Number(dateStr.slice(0, 4)));
  if (holidays.has(dateStr)) {
    return !holidays.get(dateStr);
  }
  const weekday = weekdayOfDateStr(dateStr);
  return weekday >= 1 && weekday <= 5;
}

async function isWorkday(date = new Date()) {
  return isWorkdayDateStr(toBeijingDateStr(date));
}

// 今天是否为本周(周一~周日)最后一个工作日
async function isLastWorkdayOfWeek(date = new Date()) {
  const today = toBeijingDateStr(date);
  if (!(await isWorkdayDateStr(today))) {
    return false;
  }
  // 检查今天之后、下周一之前的所有日子(含周日调休上班的情况)
  let next = addDaysDateStr(today, 1);
  while (weekdayOfDateStr(next) !== 1) {
    if (await isWorkdayDateStr(next)) {
      return false;
    }
    next = addDaysDateStr(next, 1);
  }
  return true;
}

// 今天是否为本月最后一个工作日
async function isLastWorkdayOfMonth(date = new Date()) {
  const today = toBeijingDateStr(date);
  if (!(await isWorkdayDateStr(today))) {
    return false;
  }
  const lastDay = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)
  ).getUTCDate();
  for (let d = Number(today.slice(8, 10)) + 1; d <= lastDay; d++) {
    const dateStr = `${today.slice(0, 8)}${String(d).padStart(2, "0")}`;
    if (await isWorkdayDateStr(dateStr)) {
      return false;
    }
  }
  return true;
}

// 日报用：是否跳过今天(节假日/周末)
async function isHoliday() {
  if (!SKIP_HOLIDAYS) return false;
  return !(await isWorkday());
}

// ---------- 翻译 ----------
function buildBaiduTranslateUrl(q) {
  const salt = Date.now();
  const sign = crypto
    .createHash("md5")
    .update(BAIDU_APP_ID + q + salt + BAIDU_SECRET_KEY)
    .digest("hex");
  return `https://fanyi-api.baidu.com/api/trans/vip/translate?q=${encodeURIComponent(
    q
  )}&from=en&to=zh&appid=${BAIDU_APP_ID}&salt=${salt}&sign=${sign}`;
}

async function requestBaiduTranslate(q) {
  const response = await fetch(buildBaiduTranslateUrl(q));
  const result = await response.json();
  if (result.error_code) {
    throw new Error(`翻译API错误: ${result.error_code} ${result.error_msg}`);
  }
  return result.trans_result || [];
}

// 偶发限流/网络抖动时重试一次(每次重新生成 salt/sign)
async function requestBaiduTranslateWithRetry(q) {
  try {
    return await requestBaiduTranslate(q);
  } catch (error) {
    log(`批量翻译请求失败: ${error.message}，2 秒后重试一次`, "error");
    await sleep(2000);
    return await requestBaiduTranslate(q);
  }
}

// 批量翻译：百度 API 支持用 \n 拼接多条一次翻译，避免逐条请求触发 QPS 限制
async function translateBatch(texts) {
  const needTranslate = texts.filter(
    (t) => t && t !== "No description provided."
  );
  if (needTranslate.length === 0) {
    return texts.map(() => "");
  }

  const translatedMap = new Map();
  try {
    // 单次请求有长度上限，超长按 5000 字节分批(免费版限 1 QPS，批间等待 1.5 秒)
    const chunks = [];
    let cur = [];
    let curBytes = 0;
    for (const text of needTranslate) {
      const bytes = byteLength(text);
      if (curBytes + bytes > 5000 && cur.length > 0) {
        chunks.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(text);
      curBytes += bytes;
    }
    if (cur.length > 0) chunks.push(cur);

    for (let i = 0; i < chunks.length; i++) {
      const transResult = await requestBaiduTranslateWithRetry(
        chunks[i].join("\n")
      );
      // 百度按行有序返回：行数一致时按索引对齐，不一致时退回按原文匹配兜底
      if (transResult.length === chunks[i].length) {
        chunks[i].forEach((text, idx) => {
          translatedMap.set(text, transResult[idx].dst);
        });
      } else {
        for (const item of transResult) {
          translatedMap.set(item.src, item.dst);
        }
        log(
          `翻译返回行数(${transResult.length})与请求(${chunks[i].length})不一致，已按原文匹配`,
          "info"
        );
      }
      if (i < chunks.length - 1) {
        await sleep(1500);
      }
    }
    log(`批量翻译完成，共 ${needTranslate.length} 条`, "success");
  } catch (error) {
    log(`批量翻译失败: ${error.message}，推送将只包含英文描述`, "error");
  }

  return texts.map((t) => translatedMap.get(t) || "");
}

// ---------- GitHub Trending ----------
// 抓取 trending 页面：网络异常和 429/5xx 最多重试 3 次，其它 4xx 直接失败
async function fetchTrendingHtml(since) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        `https://github.com/trending?since=${since}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "text/html",
          },
        }
      );
      if (response.ok) {
        return await response.text();
      }
      lastError = new Error(`HTTP ${response.status}`);
      // 429/5xx 重试有意义；404 等其它 4xx 重试无意义
      lastError.retryable =
        response.status === 429 || response.status >= 500;
    } catch (error) {
      // 网络抖动(连接重置/超时/响应中断)默认可重试
      lastError = error;
      lastError.retryable = true;
    }
    if (!lastError.retryable) {
      throw lastError;
    }
    log(
      `抓取 trending 页面第 ${attempt} 次失败: ${lastError.message}，3 秒后重试`,
      "error"
    );
    await sleep(3000);
  }
  throw lastError;
}

// 解析 trending 页面 HTML，提取前 10 个项目
function parseTrendingHtml(html) {
  const $ = cheerio.load(html);
  const repos = [];
  $("article.Box-row")
    .slice(0, 10)
    .each((_, el) => {
      const row = $(el);
      repos.push({
        title: row.find("h2").text().trim().replace(/\s+/g, "") || "",
        desc: row.find("p").text().trim() || "No description provided.",
        stars: row.find('a[href*="stargazers"]').text().trim() || "0",
        todayStars:
          row
            .find('span[class*="d-inline-block float-sm-right"]')
            .text()
            .trim() || "0",
        language:
          row.find('span[itemprop="programmingLanguage"]').text().trim() || "",
        forks:
          row.find('a[href*="network/members"]').text().trim() || "0",
      });
    });
  return repos;
}

// 获取 GitHub Trending 数据(页面是服务端渲染的静态 HTML，直接抓取解析，无需启动浏览器)
async function getTrendingRepos(since = "daily") {
  log(`抓取 GitHub Trending 页面 (${since})...`);
  const html = await fetchTrendingHtml(since);

  log("解析页面数据...");
  const repos = parseTrendingHtml(html);
  log(`成功获取 ${repos.length} 个热门项目`, "success");
  if (repos.length === 0) {
    // 页面结构变化或被反爬时解析结果为空，直接失败让 CI 状态变红，避免"成功但没发消息"
    throw new Error("未解析到任何热门项目，GitHub 页面结构可能已变化");
  }

  const translatedDescs = await translateBatch(repos.map((r) => r.desc));

  // 返回渲染所需的原始数据，超长降级(截断描述)在发送侧做
  return repos.map((repo, i) => {
    const todayStars = repo.todayStars.match(/[\d,]+/)[0] || "0";
    return {
      title: repo.title,
      url: `https://github.com/${repo.title}`,
      meta: [
        repo.language && `💻 ${repo.language}`,
        `⭐ ${repo.stars}`,
        `🔥 +${todayStars}`,
      ]
        .filter(Boolean)
        .join(" | "),
      descEn: repo.desc === "No description provided." ? "" : repo.desc,
      descZh: translatedDescs[i] || "",
    };
  });
}

// ---------- 企业微信 ----------
// 描述超长截断:英文在单词边界断开，中文直接按字符
function ellipsis(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+\S*$/, "") + "...";
}

// 项目块:标题链接、元信息、中英描述各一行;descLimit 未传时不截断
function renderBlocks(repos, descLimit) {
  return repos.map((repo, i) => {
    const descs = [repo.descEn, repo.descZh]
      .map((text, idx) =>
        descLimit ? ellipsis(text, idx === 0 ? descLimit.en : descLimit.zh) : text
      )
      .filter(Boolean);
    return [
      `### ${i + 1}. [${repo.title}](${repo.url})`,
      repo.meta,
      ...(descs.length > 0 ? descs : ["暂无描述"]),
    ].join("\n");
  });
}

// 把项目块分组，保证每组不超过 budget 字节
function splitBlocks(blocks, budget) {
  const groups = [];
  let cur = [];
  let curBytes = 0;
  for (const block of blocks) {
    const blockBytes = byteLength(block);
    if (curBytes + blockBytes > budget && cur.length > 0) {
      groups.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(block);
    curBytes += blockBytes;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

// 发送到企业微信:完整内容能装下就单条;超长先截断项目描述再试;
// 仍超长(极端情况)才按项目块分条，分组预留页眉页脚和"第 x/n 部分"标注余量
async function sendToWechat(repos, title) {
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

    const header = (label) => `# 🌟 ${title} (${formattedDate})${label}\n\n`;
    const footer =
      "\n\n> 数据来源: [GitHub Trending](https://github.com/trending)";
    const asSingle = (blocks) => `${header("")}${blocks.join("\n\n")}${footer}`;

    let blocks = renderBlocks(repos);
    let truncated = false;
    if (byteLength(asSingle(blocks)) > WECHAT_MARKDOWN_MAX_BYTES) {
      blocks = renderBlocks(repos, DESC_MAX_CHARS);
      truncated = true;
    }

    const single = asSingle(blocks);
    if (byteLength(single) <= WECHAT_MARKDOWN_MAX_BYTES) {
      await postWechat(single);
      log(
        `消息发送成功${truncated ? "(描述超长已截断)" : ""}`,
        "success"
      );
      return;
    }

    const overhead =
      byteLength(header(" 第99/99部分")) + byteLength(footer) + 64;
    const groups = splitBlocks(blocks, WECHAT_MARKDOWN_MAX_BYTES - overhead);
    for (let i = 0; i < groups.length; i++) {
      const label = ` 第${i + 1}/${groups.length}部分`;
      await postWechat(`${header(label)}${groups[i].join("\n\n")}${footer}`);
      if (i < groups.length - 1) {
        await sleep(1000); // 企微机器人有频率限制，分条间隔 1 秒
      }
    }
    log(`内容超长，已分 ${groups.length} 条发送成功`, "success");
  } catch (error) {
    log(`发送消息失败: ${error.message}`, "error");
    throw error;
  }
}

// 企微接口失败时大多仍返回 HTTP 200，必须读取 body 的 errcode 才能发现
async function postWechat(content) {
  let response;
  try {
    response = await requestWechat(content);
  } catch (error) {
    // 网络抖动重试一次；企微业务错误(errcode)不会进这个分支，不会重复发送
    log(`请求企微接口异常: ${error.message}，2 秒后重试一次`, "error");
    await sleep(2000);
    response = await requestWechat(content);
  }
  const body = await response.json().catch(() => ({}));
  log(`企微接口响应: HTTP ${response.status} ${JSON.stringify(body)}`);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  if (body.errcode !== 0) {
    throw new Error(
      `企微返回错误: errcode=${body.errcode}, errmsg=${body.errmsg}`
    );
  }
}

function requestWechat(content) {
  return fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content },
    }),
  });
}

module.exports = {
  log,
  getTrendingRepos,
  parseTrendingHtml,
  sendToWechat,
  isWorkday,
  isLastWorkdayOfWeek,
  isLastWorkdayOfMonth,
  isHoliday,
  splitBlocks,
};
