# tests/

Playwright 端到端测试 + 审查报告。全部是纯 ESM Node 脚本，不需要测试框架，不改动应用代码。

| 文件 | 作用 |
|---|---|
| `REVIEW.md` | 2026-09-25 的全面审查报告：23 条发现（含证据、代码位置、修法）、通过项、后端待确认项 |
| `demo.test.mjs` | `?demo=1` 全流程走查（登录 → 抓取 → 照片/AI → 标注 → 待取订单 → 草稿 → Review → 账单 → 品牌管理 → 改 PIN → 切站点 → 登出/续用 → 注册 → 响应式 → 无障碍基础） |
| `mock.test.mjs` | 用 `page.route` 拦截 railway 域名做脚本化后端，跑真实登录/保存/过期/修正路径，外加针对 REVIEW.md 各缺陷的探针（探针"FAIL"= 缺陷仍在，修好后自然转绿） |
| `probe3.test.mjs` | 两个补充探针：hydrate 提示从不显示；字段清空后 AI 读数不被采纳 |
| `harness.mjs` | 极简断言/报告工具 |
| `eslint.config.mjs` | ESLint flat config（no-undef、no-shadow、no-unused-vars 等） |
| `run.sh` | 起临时静态服务器，依次跑三套 + ESLint |

## 运行

```bash
npm i -D playwright && npx playwright install chromium   # 一次性
bash tests/run.sh                                        # 全部
# 或单跑一套（先在仓库根目录起 python3 -m http.server 8080）
node tests/mock.test.mjs
```

- `APP_URL` 环境变量可指向别的地址（默认 `http://127.0.0.1:8080/`）。
- 后端从不被真正请求：demo 模式由 `js/demo.js` 应答，mock 套件由 `page.route` 应答。
- 截图输出到 `tests/shots/`（已 gitignore）。
- 当前基线（提交 add0c0f）：demo 22/24，mock 11/26，probe3 0/2。失败项与 REVIEW.md 一一对应。
