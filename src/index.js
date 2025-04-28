
const { log, getTrendingRepos, sendToWechat } = require('./utils');

(async () => {
  try {
    log("开始执行GitHub热门项目获取任务");
    const startTime = Date.now();

    const trending = await getTrendingRepos("daily");
    await sendToWechat(trending, "GitHub今日热门项目");

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    log(`任务执行完成，耗时 ${duration} 秒`, "success");
  } catch (e) {
    log(`任务执行失败: ${e.message}`, "error");
    process.exit(1);
  }
})();
