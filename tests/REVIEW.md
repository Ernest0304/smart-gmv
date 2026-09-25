# Smart GMV 全面审查报告

日期：2026-09-25 · 分支 `claude/brave-noether-b9inw6`（与 `origin/main` 一致，提交 add0c0f）

## 1. 范围与方法

仓库是一个纯静态 PWA（index.html + js/app.js 3484 行 + js/config.js + js/demo.js + css/app.css），没有任何测试、lint 或构建配置。后端域名 `smart-gmv-server-production.up.railway.app` 在本环境被代理拦截（403），所以真实接口路径全部用 Playwright 的脚本化 mock 后端验证，未对生产后端发过任何请求。

| 层次 | 做了什么 | 结果 |
|---|---|---|
| 语法 / 静态 | `node --check` 三个脚本；ESLint 10（自定义规则集：no-undef、no-shadow、no-unused-vars 等） | 0 语法错误；0 错误；37 条警告（全部为风格类，见 §3 #23） |
| 人工审计 | 通读全部 JS/HTML，逐个检查 44 处 `innerHTML`、会话/令牌处理、状态机、并发路径 | 发现的怀疑点全部写成探针去验证 |
| 运行时（demo 模式） | Playwright + Chromium，模拟 Pixel 尺寸触屏，走完登录、抓取、照片、AI 读数、标注、待取订单、状态切换、草稿、Review、账单、品牌管理、加品牌、改 PIN、切站点、登出/续用、自助注册、返回手势、响应式 4 种宽度、基础无障碍 | 24 项中 22 项通过，2 项失败指向同一个真实缺陷（#11） |
| 运行时（mock 后端） | 真实登录流程（PIN 校验/首登建 PIN/409）、会话过期、抓取保存 payload、保存失败重试、实时轮询合并、Review 回写、租户修正收件箱、开机 GMV 自动关店、加品牌、beforeunload 守卫，加上 16 个针对性探针 | 26 项中 11 项通过；15 项失败**全部是探针按预期触发，即确认的缺陷** |
| 视觉 | 截图 360 / 390 / 768 / 1440 四档，检查横向溢出 | 无溢出；桌面控制台版式和手机版式正常 |

测试脚本在仓库的 `tests/` 目录（`harness.mjs`、`demo.test.mjs`、`mock.test.mjs`、`probe3.test.mjs`、`eslint.config.mjs`），运行方式见 `tests/README.md`。

## 2. 总体结论

代码质量整体不错：所有字符串几乎都经过 `esc()`（针对品牌/站点/员工/客户名的敌意名称全屏扫描通过，0 次脚本执行），没有第三方 JS，`?api=` 覆盖只放行 localhost，PIN 从不落盘，401 统一处理，保存失败有明确的红卡和守卫。demo 模式是一个很好的免后端演练层。

但按成熟产品标准，有 **4 个高危、8 个中危** 问题需要修，其中两个是安全问题（PIN 常驻内存、dine-in 属性注入），两个直接影响账单数据正确性（照片挂错商户、营业日期冻结）。

## 3. 缺陷清单

严重度：🔴 高 · 🟠 中 · 🟡 低。每条都注明证据来源（探针名）和建议修法。

### 🔴 高

**#1 登录后 PIN 一直留在内存，会话过期后按任意一个键就用旧 PIN 重新登录**（安全）
- `verifyPin()` / `claimPin()` 成功后没有清空 `state.pin`（js/app.js:717-754）。`api()` 的 401 分支直接 `loginStep('pin')`（js/app.js:40-48），既不清 `state.pin` 也不重画点阵。
- 证据（mock 套件"session expiry"）：登录后 `state.pin === "1234"`；过期屏幕上 4 个点全是实心；陌生人按一个"9"，客户端发出的 verify 请求 body 是 `pin: "1234"`，直接回到清单页。
- 共享站点平板长时间不锁屏，这就是默认状态。
- 修法：verify/claim 成功后 `state.pin = ''; state.pinFirst = ''`；401 分支里同样清空并 `paintPin()`。

**#2 会话过期重新输入 PIN 后，本机未保存的全部工作被清零**（数据丢失）
- 401 → PIN → `verifyPin()` → `enterApp()`，而 `enterApp()` 无条件重置 `state.records / baselines / baselineMeta / history`（js/app.js:765-768），不经过 `logoutRisks()` 守卫。
- 证据（同上探针）：K1 已输入 77 未保存，重新登录后为 `undefined`。草稿、照片、已输数字全丢，且没有任何提示。
- 修法：同一员工、同一站点、同一营业日的再认证走一条只换 token、只重新 hydrate（hydrate 已经尊重 `localBusy`）的路径，不重置本地状态。

**#3 照片可能挂到另一个商户上**（账单证据错位）
- `takeSingle` 的 onchange 里先做异步 FileReader + `downscale()`，完成后才在 `runExtraction()` 里冻结 `state.current`（js/app.js:284-296, 2052-2053）。解码大照片期间用户按返回并打开下一个厨房，照片和随后的 AI 读数就写到那个厨房。`takeExtras` 同样（js/app.js:304-330）。
- 证据（探针"photo picked for kitchen A"）：把 `downscale` 放慢到 1.5 s 后，A 商户无照片，B 商户有照片。12MP 照片在低端安卓上解码 0.5–2 s，加上自动跳转到下一个厨房的设计，这个窗口是真实存在的。
- 修法：在 `openPicker/openCamera/openExtrasPicker/openExtrasCamera` 时就把 `{...state.current}` 存进 pending 对象，一路传给 `runExtraction(ctx, ch, jpeg)`。

**#4 营业日期在登录时冻结，隔夜没登出的手机会把第二天上午的开机 GMV 记到前一天**
- `state.salesDate = businessDate()` 只在 `enterApp()` 执行一次（js/app.js:772）。
- 证据（探针"business date frozen"，用 Playwright 时钟控制）：23:30 登录，次日 10:05 保存开机 GMV，payload `salesDate = 2026-09-24`，recordId `...20260924-B`。当晚重新登录后的闭店记录会落在 25 日，于是 25 日没有基线（NO_BASELINE），24 日多了一条错的基线。
- 修法：在 `visibilitychange`、每次 `renderChecklist()` 或每次保存前重新计算营业日期；变化时提示并重新进入当天（重新 hydrate）。顺带把 `#hdr-date` 改成显示营业日期而不是日历日期。

### 🟠 中

**#5 月度 dine-in 读数直接拼进 `value=""` 属性，属性注入可执行脚本**（安全）
- js/app.js:3386-3389 四个 input 的 `value="${x.dineinOrders ?? ''}"` 未经 `esc()`；`num()`（3381）也未转义。数据来自 `/api/dinein/read` 的 AI 输出，AI 输出受上传截图内容影响。
- 证据（探针"dine-in attribute injection"）：返回 `" autofocus onfocus="window.__inj=1` 后 `window.__inj === 1`。
- 修法：四个值全部 `esc(String(...))`，或先 `Number()` 再输出。

**#6 账单页把服务端字段原样插入 HTML**（安全 / 防御深度）
- `m.days`（3266）未转义；`m.totalOrders.toLocaleString()`（3267）和 `t.totalOrders.toLocaleString()`（3278）在服务端返回字符串时原样输出。
- 证据（探针"billing renders server numbers"）：`days` 和 `totalOrders` 里的标签都被渲染成了元素。
- 修法：`Number(m.days)`、`Number(x).toLocaleString()`；同时加 CSP（见 #17）。

**#7 开机时 sessionStorage 里有过期 token，站点列表会卡在"HTTP 401 / Try again"死循环**
- `loadCatalog()` 用原生 fetch 并带上旧 token（js/app.js:63-66），失败后 Retry 仍带同一个 token。
- 证据（探针"stale token at boot"）：两次请求头都是 `Bearer stale`，永远无法恢复。前提是服务端对 `/api/catalog` 的坏 token 返回 401（后端不可达，未能验证）。
- 同一根源：`/api/staff/verify`、`/api/staff/pin`、`/api/staff` 也会带上旧 token（探针"stale token is also sent to the PIN verify endpoint"）。
- 修法：catalog 遇 401 时 `setSession('')` 并不带头重试；登录类端点不附加 Authorization。

**#8 登录后拉商户列表失败，清单页显示"No merchants at this site yet · Add the first one"**
- `loadCatalog()` 内部吞掉异常并把错误画到隐藏的登录页里，所以 `enterApp()` 里的 try/catch 永远不触发（js/app.js:760-763），提示语"pull to retry"对应的下拉刷新也不存在。
- 证据（探针"post-login catalog failure"）：第二次 catalog 返回 500，清单页显示空状态，没有 toast。员工会以为站点真的没有品牌。
- 修法：让 `loadCatalog` 返回成功/失败，失败时在清单页显示错误 + 重试按钮。

**#9 Catering 入口把品牌加进 catering 后，已保存记录"消失"，守卫也看不见进行中的保存**
- 商户 id 用过滤后的数组下标（`${site}-${kitchen}-${i}`，js/app.js:209）。catering 切换会改变过滤结果，`state.merchants` 重建后 id 全部错位，而 `state.records` 仍按旧 id 存。
- 证据（探针"catering re-index"）：Gamma Grill 保存成功后 id 从 `S1-K3-1` 变为 `S1-K3-2`，卡片回到"○ capture"。`unsavedRecords()` 按 `state.merchants` 遍历，失败/进行中的保存也从登出守卫里消失。
- 修法：id 改用稳定键（site + kitchen + brand slug 或 sfdcId），不用下标。

**#10 重拍照片后，旧照片上的手动修改和标注框保留在新照片上，新 AI 读数被忽略**
- `runExtraction` 用 `{...prevVal, ...}` 保留 `editedOrders/editedGmv/finalOrders/marks/corrections`（js/app.js:2072-2074），`settle()` 又因 `prev.editedOrders` 拒绝采纳新读数（2086-2089）。
- 证据（探针"retake after a manual edit"）：重拍后 `finalOrders` 仍是旧的手输 50，`aiOrders` 是新的 7，旧标注框还画在新照片上并随保存进入 corrections 日志。
- 修法：重拍时清掉与旧照片绑定的 edited 标志、final 值、marks、corrections、mismatch（保留 extras）。

**#11 字段清空后再拍照，AI 读数只显示在输入框里却未被采纳，保存按钮锁死**
- 清空字段时 `finalOrders = undefined` 但 `editedOrders = true`（js/app.js:1915/1918）；`settle()` 尊重 edited 标志，于是 final 保持 undefined；输入框却用 `finalOrders ?? orders` 回退显示 AI 值（1845-1846）。
- 证据（probe3 + demo 套件的两条失败）：输入框显示 7 / 210.25，`finalOrders === undefined`，按钮"Confirm & save"禁用，环形进度 1/2。员工看到数字已填却无法保存，只能重新输入一遍。
- 修法：清空字段时把 `editedOrders/editedGmv` 置回 false；或 `settle()` 里仅当 `prev.finalX !== undefined` 才保留手输值。

**#12 实时轮询会覆盖已保存记录上的未保存修改**
- `localBusy()` 只保护 `!r.saved && recHasChannelData(r)`（js/app.js:826-835）；对一条已保存记录打开修改、返回清单、20 s 轮询发现版本变化，本机修改被服务端版本静默覆盖。
- 证据（mock 套件"live round"）：本地改成 99，刷新后变回 1。
- 修法：记录级 dirty 标志（任一 channel `_dirty`/`edited` 且尚未保存）也算 busy。

### 🟡 低

**#13 服务端出现客户端不认识的 channel 键会直接抛异常**：`channelSummaryText`（2487）、`extrasBlockers`（2337）、Review 基线卡（1456）都用 `CH_META[ch].name`。探针返回 `deliveroo` 键后，改状态点保存抛 `Cannot read properties of undefined (reading 'name')`，确认弹窗不出现。清单页的桌面看板已经做了 `CH_META[k] || {...}` 兜底，其他地方补齐即可。

**#14 切换站点后上一个站点的修正请求卡片仍显示**：`enterApp()` 不重置 `state.amendments`，Catering 入口的 hydrate 又提前返回（838）。探针确认卡片留在 Catering 页，点开找不到商户只会 toast。修法：`enterApp()` 里 `state.amendments = []`。

**#15 Review 里的 Today 标签打开记录并保存后，自动跳到下一个厨房而不是回到 Review**：offset 为 0 时走了今晚回合的 `afterSaveGo` 路径（2825-2837），与"Review 编辑回到来处"的注释不符。探针确认落在 Beta Bowls 的抓取页。

**#16 月度 dine-in 非法输入不拦截，NaN 变 null 保存**：`saveDinein` 不检查 `.bad` 行（3455-3484）；探针里输入 `abc`，保存按钮仍可用，payload `dineinGmv: null`，toast 显示保存成功。

**#17 没有 CSP**：脚本全部外链、没有内联事件处理器，`script-src 'self'` 可以直接上，能把 #5/#6 这类注入降为无害。建议在 index.html 加 `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self' https://smart-gmv-server-production.up.railway.app; img-src 'self' data: blob: https://smart-gmv-server-production.up.railway.app; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'">`（本地开发的 `?api=http://localhost` 需要另行放行）。

**#18 会话 token 放在照片代理 URL 的查询串里**（js/app.js:51-55）：代码注释已说明是取舍，探针确认请求为 `/api/photo/<id>?t=tok-1`。它会进入 Railway 访问日志和任何中间代理日志。可考虑短时签名的单张照片 URL，或用 Service Worker 给 img 请求加头。

**#19 保存后 base64 照片仍留在内存**：当 `/api/extract` 已经把照片存到 Drive（返回 photoLink）时，保存 payload 只带 link（这点探针确认正确），但 `adoptLinks()` 只在响应 `photoLinks` 里有该 channel 时才丢弃 `photoUrl`（2533-2545）。若真实后端对已有 link 的 channel 不回传 photoLinks，每张 300–600 KB 的 base64 会在整轮中留在内存，正是注释里说会让 Safari 驱逐标签页的情况。需要用真实后端确认。

**#20 hydrate 期间的"⏳ Checking the server…"从未显示**：`state.hydrating = true` 之后没有重绘（812-822），探针确认此时进度行仍是"0 of N captured"。修法：置位后调用一次 `renderChecklist()`。

**#21 无障碍**：`#reg-home` 下拉、`#bl-from`/`#bl-to` 日期框没有关联 label；`.field-label` 都是无 `for` 的 label；`#autonext-toggle` 高 28 px，低于 44 px 的触控目标建议；弹层不锁定焦点、Esc 不关闭。做得好的：lang、可缩放 viewport、图标按钮全有 title/aria-label、toast 有 `role=status aria-live`、`:focus-visible`、`prefers-reduced-motion`、safe-area 内边距。

**#22 一致性小问题**：`<meta name=theme-color>` 是 #000000 而 manifest 是 #B01E2E；`renderSites` 对普通站点计入已禁用品牌、对 Catering 排除；`saveAmend` 把 `resp.billing` 当字符串而 `saveRecord` 兼容对象；demo 目录用 `partTime`、注册响应用 `partTimer`；会话过期时"Session expired"和"Could not check the server"两个 toast 互相覆盖；`photoUrl(id)` 未做 URL 编码；HEIC 在 Chrome 解码失败时会把原始 HEIC 整个发给后端。

**#23 ESLint 提示**：`pinKey` 里一层多余的块（635）；`runExtraction` 的参数名 `photoUrl` 遮蔽了同名函数（2052）；`renderBilling` 里 `manual` 未使用（3245）；demo.js 的 `wait` 用 `new Promise((r) => setTimeout(r, ms))` 触发 no-promise-executor-return（无害）。

## 4. 通过的检查（值得保留的做法）

- 敌意名称 XSS 全屏扫描：品牌/站点/员工/客户/租户邮箱/标记全部注入 `<img onerror>`，0 次执行。
- `?api=` 只接受 `http(s)://localhost(:port)`，crafted 链接无法把数据导向别的后端。
- PIN 只存在于请求 body，从不落 localStorage；"最近使用"卡片不含 PIN；demo 模式的所有 staff 端点都被本地拦截（不会写真实 Staff 表）。
- 401 统一由 `api()` 处理；保存 90 s 超时；保存失败红卡 + 登出守卫 + "Retry saving all"链路完整。
- 确定性 recordId（同商户同日重存为原地更新），Review 回写复用服务端 recordId，payload 结构正确。
- 拍照走 `capture=environment` 独立 input；照片重编码为 JPEG 再上传。
- 返回手势陷阱、beforeunload 守卫、`sessionStorage` 会话、`visibilitychange` 触发轮询都按设计工作。
- 4 档宽度无横向溢出；桌面控制台布局和手机布局都正常；资源总重约 75 KB gzip，无第三方依赖；`?v=` 在最近一次改动里正确同步。

## 5. 需要后端侧确认的点（本环境无法访问后端）

- PIN 是 4 位数（1 万种组合），服务端是否有失败次数限制/锁定。
- token 有效期多长；`/api/catalog` 对无效 token 是拒绝还是降级（决定 #7 是否真实发生）。
- `POST /api/records` 对只带 `photoLink` 的 channel 是否回传 `photoLinks`（决定 #19）。
- `salesDate` 的服务端校验窗口（客户端 catering 日期只限制上限、不限下限）。
- 两台手机同时改同一商户是最后写入者胜出，没有冲突提示；如需要，服务端可返回 `updatedAt` 供客户端比对。

## 6. 建议的下一步

1. 先修 #1–#4（一天内可完成，改动都很局部），再修 #5/#6 并加 CSP。
2. 把本次的 Playwright 套件放进仓库（`tests/`）并配一个 GitHub Actions 任务：demo 模式无需后端即可跑完整走查；mock 后端套件可作为回归测试。
3. 加一个极简的前端错误上报（`window.onerror` / `unhandledrejection` → 后端一条日志），否则夜间现场的异常没有任何可见性。
4. 把 `?v=` 改成部署时自动生成（commit hash），消除人工漏改的风险。
