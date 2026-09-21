const {
  log,
  getTrendingRepos,
  sendToWechat,
  isHoliday,
  isLastWorkdayOfWeek,
  isLastWorkdayOfMonth,
} = require("./utils");

// 用法: node src/index.js [daily|weekly|monthly]
const MODE = process.argv[2] || "daily";
// 手动触发(workflow_dispatch)时跳过节假日/最后工作日判断，便于调试或补发
const MANUAL_TRIGGER = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

const CONFIG = {
  daily: { since: "daily", label: "日", title: "GitHub今日热门项目" },
  weekly: { since: "weekly", label: "周", title: "GitHub本周热门项目" },
  monthly: { since: "monthly", label: "月", title: "GitHub本月热门项目" },
};

async function checkSkip(mode) {
  if (MANUAL_TRIGGER) return null;
  if (mode === "daily" && (await isHoliday())) {
    return "今天是节假日，跳过执行";
  }
  if (mode === "weekly" && !(await isLastWorkdayOfWeek())) {
    return "今天不是本周最后一个工作日，跳过周报";
  }
  if (mode === "monthly" && !(await isLastWorkdayOfMonth())) {
    return "今天不是本月最后一个工作日，跳过月报";
  }
  return null;
}

(async () => {
  const config = CONFIG[MODE];
  if (!config) {
    log(`未知的运行模式: ${MODE}，可用: daily / weekly / monthly`, "error");
    process.exit(1);
  }

  try {
    log(`开始执行GitHub${config.label}榜获取任务`);
    const startTime = Date.now();

    const skipReason = await checkSkip(MODE);
    if (skipReason) {
      log(skipReason, "info");
      process.exit(0);
    }

    const repos = await getTrendingRepos(config.since);
    await sendToWechat(repos, config.title);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`任务执行完成，耗时 ${duration} 秒`, "success");
  } catch (e) {
    log(`任务执行失败: ${e.message}`, "error");
    process.exit(1);
  }
})();
