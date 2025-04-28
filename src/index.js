const { log, getTrendingRepos, sendToWechat, isHoliday } = require('./utils');

(async () => {
  try {
    log("开始执行GitHub热门项目获取任务");
    const startTime = Date.now();

    // 检查是否为节假日
    if (await isHoliday()) {
      log("今天是节假日，跳过执行", "info");
      process.exit(0);
    }

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
