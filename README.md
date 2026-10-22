# B站直播消费账本（bili-live-ledger）

开源、没有服务器、不用扫码的 B 站直播送礼消费统计。

它是一个用户脚本，直接在 `live.bilibili.com` / `link.bilibili.com` 的页面里运行，用你浏览器里本来就登录着的 B 站账号读取你自己的送礼记录。记录只保存在你的浏览器里，不经过任何第三方服务器。

- 项目首页和离线查看器：<https://enkianssus.github.io/bili-live-ledger/>
- 安装脚本（先装好脚本管理器再打开）：<https://enkianssus.github.io/bili-live-ledger/bili-live-ledger.user.js>

## 功能

- **总览**：累计花费（元 / 电池）、送礼笔数、送过的主播数、记录时间范围、每月花费柱状图、花费最多的主播
- **主播**：按主播汇总花费、笔数、第一次和最近一次送礼时间，点一行看这位主播的全部明细
- **礼物**：按礼物汇总数量和花费
- **明细**：搜索主播或礼物，按月份、主播筛选，分页浏览
- **盲盒（实验性）**：按开盒记录算盈亏（开出礼物的价值 − 盲盒价格）
- **本地累积**：第一次同步读取 B 站能给的全部记录，之后只补新记录（回看 7 天，补上被退回之类的状态变化）。B 站接口不再提供的老记录也会一直留在本地
- **数据**：导出 JSON（备份）、导出 CSV（Excel 可直接打开）、导入 JSON 合并、清空本地数据
- **离线查看器**：`index.html` 是一个纯静态页面，可以打开导出的 JSON 查看，不发任何网络请求

## 为什么是用户脚本，而不是一个普通网站

浏览器不允许别的网站带着你的 B 站登录状态去读 B 站接口。B 站接口只对自己的页面放行，可以用 curl 验证：

```text
Origin: https://live.bilibili.com   → Access-Control-Allow-Origin: https://live.bilibili.com
                                        Access-Control-Allow-Credentials: true
Origin: https://example.github.io   → 没有任何 CORS 头，浏览器直接拦截
```

所以任何「打开某个网站扫码登录」的统计工具，都只能由它自己的服务器替你登录、替你读数据，你的登录凭证（SESSDATA、bili_jct、refresh_token）就落在了对方服务器上，对方可以长期以你的身份操作账号。

这个工具反过来做：把代码放进 B 站自己的页面里运行。请求由浏览器自动带上登录状态，脚本本身碰不到、也不需要碰你的凭证。

## 安全边界

都可以对照 `bili-live-ledger.user.js` 自己检查：

- 只请求这几个 B 站接口：
  - `api.bilibili.com/x/web-interface/nav`（读取当前登录的账号名和 UID）
  - `api.live.bilibili.com/xlive/revenue/v2/giftStream/payRecord`（送礼记录）
  - `api.live.bilibili.com/xlive/general-interface/v1/blindFirstWin/getInfo`、`.../blind-box/drawStream`（盲盒信息和开盒记录，只在你点「读取盲盒记录」时请求）
- 不读取 `document.cookie`，不保存任何登录凭证。脚本声明为 `@grant none`，没有 `@connect`、`@require`、`GM_xmlhttpRequest`，也就没法跨域连到别的服务器
- 只读：不送礼、不点赞、不发弹幕、不关注，也不碰钱包
- 测试里有一条会检查源码中出现的所有域名都属于 `bilibili.com`，并且没有读取 Cookie 的代码

送礼记录接口 `payRecord` 是 B 站 App 的接口，需要 App 签名。脚本用的是 Android 客户端公开的 appkey / appsec（见 [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 的 APP 签名文档），只用来计算 `sign` 参数。

## 安装

1. 装一个用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或开源的 [Violentmonkey](https://violentmonkey.github.io/)。手机上可以用 Firefox for Android 装同样的扩展，iPhone 可以用 Safari 的 Userscripts 扩展。
2. 打开 <https://enkianssus.github.io/bili-live-ledger/bili-live-ledger.user.js>（或首页的「安装用户脚本」），管理器会弹出安装页面。
3. 打开 <https://live.bilibili.com/> 并登录，点左下角的「账本」，再点「同步记录」。

建议在管理器里关掉这个脚本的自动更新，每次更新前先看看改了什么。

## 数据说明

- 金额单位：送礼记录接口给的是电池（1 元 = 10 电池，心动盲盒记作 150）；盲盒接口给的价格是金瓜子（1 元 = 1000 金瓜子）。统计时统一换算成元和电池显示
- 包裹里的免费礼物、已退回的记录单独列出，不计入花费；在明细里显示为灰色
- 记录保存在当前浏览器 `live.bilibili.com`（或 `link.bilibili.com`）站点的 IndexedDB 里，两个站点各存各的。换浏览器、清理网站数据都会丢失，记得用「导出 JSON」备份

## 已知限制

- **还没有用真实账号跑过完整同步。** 接口用法参考了公开资料和现有客户端的调用方式，单元测试覆盖的是签名、翻页、去重和统计逻辑。第一次用如果报错，请把页面上显示的错误码记下来反馈
- 盲盒盈亏是实验性的；开出礼物的价格取自盲盒接口当前的奖池，已经下架的礼物会显示为「价格未知」，不计入价值
- 刻意没有做的功能：自动点赞、自动发弹幕、自动参与抽奖、B币兑换电池、批量移除粉丝 / 粉丝牌、直播间 OBS 特效。前几项是写操作，会用你的账号做事，不适合放进一个只读的账本；OBS 特效需要本地服务，不是用户脚本能做的

## 开发

不依赖任何第三方包，需要 Node.js 18 以上：

```bash
npm test
```

本地预览首页和离线查看器（只监听 127.0.0.1）：

```bash
npm run serve
```

服务开着的时候，在装了脚本管理器的浏览器里打开 `http://localhost:4173/bili-live-ledger.user.js` 就能直接安装本地版本。

- `bili-live-ledger.user.js`：全部代码都在这一个文件里。在 bilibili.com 上运行时是账本；被 `index.html` 引用时只提供离线查看器（`window.BiliLedger`），不发任何请求；被 Node `require` 时导出纯函数给测试用
- `index.html`：项目首页和离线查看器
- `test/ledger.test.cjs`：签名、翻页、限流重试、去重、统计、导入导出、CSV 防公式注入等测试

## 自己部署

Fork 这个仓库，在仓库设置里开启 GitHub Pages（`main` 分支根目录）即可。首页的「安装用户脚本」会直接指向同一个仓库里的 `bili-live-ledger.user.js`，代码公开可查。

## 许可

MIT。本项目是非官方工具，与哔哩哔哩无关。
