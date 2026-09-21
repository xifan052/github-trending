const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

// mock 企微 webhook：content 含 __FAIL__ 时返回 errcode 错误，否则成功
const received = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body);
    received.push(json);
    const fail = json.markdown?.content?.includes("__FAIL__");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        fail
          ? { errcode: 40058, errmsg: "markdown content size exceed" }
          : { errcode: 0, errmsg: "ok" }
      )
    );
  });
});

// WEBHOOK_URL 在模块加载时读取，需先起 mock 拿到端口再 require
// unref: 测试结束后不因 server 监听而挂住进程
const utilsReady = new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    server.unref();
    process.env.WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/hook`;
    resolve(require("../src/utils"));
  });
});

// 北京时间日期字符串 -> Date(取 UTC 正午，换算北京时间后仍是同一天)
const at = (s) =>
  new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12));

// 按 github.com/trending 实际 DOM 结构构造项目行
function fixtureRow(i, desc, lang) {
  return `
  <article class="Box-row">
    <h2 class="h3 lh-condensed">
      <a href="/owner${i}/repo${i}">
        owner${i} /
        repo${i}
      </a>
    </h2>
    <p class="col-9 color-fg-muted my-1 pr-4">${desc}</p>
    <div class="f6 color-fg-muted mt-2">
      ${lang ? `<span itemprop="programmingLanguage">${lang}</span>` : ""}
      <a class="Link--muted d-inline-block mr-3" href="/owner${i}/repo${i}/stargazers">${(i + 1) * 111},234</a>
      <a class="Link--muted d-inline-block mr-3" href="/owner${i}/repo${i}/network/members">${i * 7}</a>
      <span class="d-inline-block float-sm-right">${i * 13} stars today</span>
    </div>
  </article>`;
}

const html =
  "<html><body><main>" +
  Array.from(
    { length: 12 },
    (_, i) =>
      fixtureRow(
        i,
        i === 1 ? "" : `Description for repo ${i}.`,
        i % 3 === 2 ? "" : ["Python", "Rust", "TypeScript"][i % 3]
      )
  ).join("\n") +
  "</main></body></html>";

test("parseTrendingHtml 解析 trending 页面结构", async () => {
  const u = await utilsReady;
  const repos = u.parseTrendingHtml(html);
  assert.equal(repos.length, 10); // 12 个项目只取前 10
  assert.equal(repos[0].title, "owner0/repo0"); // 标题空白折叠
  assert.equal(repos[1].desc, "No description provided."); // 无描述兜底
  assert.equal(repos[0].stars, "111,234");
  assert.match(repos[2].todayStars, /26 stars today/);
  assert.equal(repos[2].language, "");
  assert.equal(repos[0].language, "Python");
  assert.equal(repos[0].forks, "0");
  assert.deepEqual(u.parseTrendingHtml("<html></html>"), []);
});

test("splitBlocks 按 budget 分组", async () => {
  const u = await utilsReady;
  const big = "x".repeat(3000);
  const groups = u.splitBlocks([big, big, big, big], 3600);
  assert.equal(groups.length, 4); // 两块装不进一组，只能一块一组
  assert.ok(
    groups.every((g) => Buffer.byteLength(g.join(""), "utf8") <= 3600)
  );
  assert.equal(u.splitBlocks(["a", "b"], 3600).length, 1);
});

test("工作日/节假日判断(holiday-cn 2026 公告)", async () => {
  const u = await utilsReady;
  assert.equal(await u.isWorkday(at("2026-01-01")), false); // 元旦放假
  assert.equal(await u.isWorkday(at("2026-01-04")), true); // 周日调休上班
  assert.equal(await u.isWorkday(at("2026-10-01")), false); // 国庆放假
  assert.equal(await u.isWorkday(at("2026-10-10")), true); // 周六调休上班
  assert.equal(await u.isWorkday(at("2026-09-21")), true); // 普通周一
  assert.equal(await u.isLastWorkdayOfMonth(at("2026-09-30")), true);
  assert.equal(await u.isLastWorkdayOfMonth(at("2026-09-29")), false);
  assert.equal(await u.isLastWorkdayOfMonth(at("2026-01-30")), true); // 1/31 为周六
  assert.equal(await u.isLastWorkdayOfWeek(at("2026-09-18")), false); // 9/20 调休上班
  assert.equal(await u.isLastWorkdayOfWeek(at("2026-09-20")), true);
  assert.equal(await u.isLastWorkdayOfWeek(at("2026-10-30")), true);
  assert.equal(await u.isLastWorkdayOfWeek(at("2026-10-02")), false); // 国庆周五
});

// 构造 getTrendingRepos 返回结构的项目数据
const mkRepos = (n, enLen, zhLen = 0) =>
  Array.from({ length: n }, (_, i) => ({
    title: `owner${i}/repo${i}`,
    url: `https://github.com/owner${i}/repo${i}`,
    meta: `💻 TypeScript | ⭐ ${(i + 1) * 111},234 | 🔥 +${i * 13}`,
    descEn: "E".repeat(enLen),
    descZh: "译".repeat(zhLen),
  }));

test("sendToWechat 单条能装下时不分条、不截断", async () => {
  const u = await utilsReady;
  received.length = 0;
  const repos = mkRepos(10, 150, 40);
  repos[9] = { ...repos[9], descEn: "", descZh: "" };
  await u.sendToWechat(repos, "单条测试");
  assert.equal(received.length, 1);
  const content = received[0].markdown.content;
  assert.doesNotMatch(content, /第\d+\/\d+部分/);
  assert.ok(!content.includes("..."));
  assert.ok(content.includes("暂无描述"));
  assert.ok(Buffer.byteLength(content, "utf8") <= 4096);
});

test("sendToWechat 完整内容超长时截断描述后仍单条发送", async () => {
  const u = await utilsReady;
  received.length = 0;
  await u.sendToWechat(mkRepos(10, 600, 200), "截断测试");
  assert.equal(received.length, 1);
  const content = received[0].markdown.content;
  assert.ok(content.includes("..."));
  assert.doesNotMatch(content, /第\d+\/\d+部分/);
  assert.ok(Buffer.byteLength(content, "utf8") <= 4096);
});

test("sendToWechat 截断后仍超长才分条且单条不超 4096 字节", async () => {
  const u = await utilsReady;
  received.length = 0;
  await u.sendToWechat(mkRepos(20, 600, 200), "分条测试");
  assert.ok(received.length > 1);
  for (const msg of received) {
    assert.ok(Buffer.byteLength(msg.markdown.content, "utf8") <= 4096);
  }
  assert.match(received[0].markdown.content, /第1\/\d+部分/);
});

test("sendToWechat 识别企微 errcode 错误(HTTP 200)", async () => {
  const u = await utilsReady;
  const repos = [{ ...mkRepos(1, 5)[0], descEn: "__FAIL__" }];
  await assert.rejects(
    () => u.sendToWechat(repos, "失败测试"),
    /errcode=40058/
  );
});
