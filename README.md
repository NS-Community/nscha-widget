# NSCHA widget

**Non-Surveillance CAPTCHA for Human Authentication** — 一个可以部署在自己账号下、再用一行脚本嵌进任意站点的人机验证组件。

无追踪、无第三方域名请求、无数据库、无共享存储。挑战是进程内签发的 HS256 令牌，验证是纯密码学，因此整个服务可以跑在一个 Vercel Serverless Function 里。

> 这份仓库是「可部署物」本身。文档站 `E:/nscha-docs` 解释协议，`gamesense` 论坛是第一个使用方；本仓库负责让别人也能拿到同一个组件。

---

## 一行嵌入

```html
<script src="https://your-nscha-host/widget.js" defer></script>

<form method="post" action="/login">
  <input name="username">
  <input name="password" type="password">
  <nscha-widget action="login"></nscha-widget>
  <button type="submit">登录</button>
</form>
```

验证通过后，组件会往表单里写入一个隐藏字段：

```html
<input type="hidden" name="nschaToken" value="eyJ...">
```

同时派发 `nscha:success`（`detail: { token, scope, elapsedMs }`）。提交完成后调用
`document.querySelector('nscha-widget').reset()` 清空令牌，**成功和失败分支都要清**。

### 组件属性

| 属性 | 默认 | 说明 |
| --- | --- | --- |
| `action` | `login` | 用途，必须在 `CAP_SCOPES` 白名单里 |
| `name` | `nschaToken` | 隐藏字段名 |
| `auto` | 自动求解 | 设为 `off` 则等用户点击「我是人类」 |
| `link` | 脚本所在源 | 盒子下方品牌链接 |

事件：`nscha:success` / `nscha:error` / `nscha:reset`（均 `bubbles + composed`）。
属性：`element.token`、`element.reset()`、`element.start()`。

---

## 服务端校验（真代码）

在**查询账号、发信、写数据库之前**调用 `/verify`：

```js
const res = await fetch('https://your-nscha-host/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: req.body.nschaToken,
    scope: 'login'
  })
})

if (!res.ok) return respond(403, { error: '人机验证未通过，请重试' })
// 通过之后才继续比对密码
```

失败统一返回 `403 { ok: false }`，不区分签名错、用途错还是过期 —— 细分错误会帮助探测实现细节；具体原因只写服务端日志。

也可以不调 HTTP，直接把 `src/protocol.ts` 的 `verifyToken()` 拷进自己的服务，用同一把 `CAP_TOKEN_SECRET` 本地验签。

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/challenge` | 签发挑战。请求头 `x-captcha-scope: login`，返回 `{ challenge: {c,s,d}, token, expires }` |
| `POST` | `/redeem` | 交回 `{ token, solutions: [{i,n}, …] }`，返回 `{ success: true, token, expires }` |
| `POST` | `/verify` | 业务后端调用：`{ token, scope }` → `{ ok: true }` / 403 |
| `GET` | `/config` | 公开参数（不含任何密钥） |
| `GET` | `/health` | 健康检查 |

前两个接口由 `widget.js` 内部调用，你只需要接 `/verify`。

**同源承诺**：`widget.js`、`nscha-solver.js`、`/cap/*.wasm` 全部由本服务同源提供。求解器模块求值时会立刻预取资源，因此 `widget.js` 在加载求解器**之前**就设好了三个资源地址 —— 这个顺序是硬要求，改错就会回落到公共 CDN。

---

## 本地运行

```bash
pnpm install --registry=https://registry.npmmirror.com
cp .env.example .env       # 填入 CAP_SECRET
pnpm start                 # http://localhost:8788
pnpm build                 # typecheck + 同步浏览器资源
```

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

打开 `http://localhost:8788/` 就是部署页，右侧预览卡里跑的是**真实的** `<nscha-widget>`：自动求解、拿到令牌、再调用 `/verify` 显示结果。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CAP_SECRET` | 必填 | HS256 签名密钥，轮换会让在途挑战失效 |
| `CAP_TOKEN_SECRET` | 同 `CAP_SECRET` | 兑换令牌签名密钥；若业务系统也用 JWT 建议单独设 |
| `CAP_CHALLENGE_COUNT` | `20` | 子挑战数量 |
| `CAP_CHALLENGE_SIZE` | `32` | 盐长度（字节） |
| `CAP_CHALLENGE_DIFFICULTY` | `3` | 前导零个数，每 +1 期望尝试 ×16 |
| `CAP_EXPIRES_SECONDS` | `600` | 挑战有效期 |
| `CAP_TOKEN_TTL_SECONDS` | `1200` | 兑换令牌有效期 |
| `CAP_SCOPES` | `login,register,reset` | 用途白名单，新增表单先登记 |
| `ALLOWED_ORIGIN` | `*` | 允许嵌入的站点来源，上线后建议收敛 |
| `NSCHA_LABEL` / `NSCHA_LINK` | — | 盒子品牌文案与链接 |

`c × d` 直接决定 `/redeem` 的服务端验算耗时，必须留在函数时间预算内（Vercel `maxDuration: 10`）。

---

## 部署到 Vercel

1. 把本仓库推到 GitHub（私有即可），在 Vercel 里 Import。推送后把 `public/index.html` 里两个 Deploy 按钮的 `repository-url` 换成你自己的仓库地址 —— 默认值 `NS-Community/nscha-widget` 只是占位，仓库尚未创建时按钮不会生效。
2. 环境变量填 `CAP_SECRET`，建议再填 `ALLOWED_ORIGIN` 收敛到你自己的域名。
3. Build Command 用 `pnpm build`，其余保持默认。`vercel.json` 已把四个 API 路径重写到 `api/index.ts`，`public/` 由平台静态托管。
4. 部署完成后，`https://<你的项目>.vercel.app/widget.js` 就是可嵌入的脚本地址。

文档站是独立的 Docusaurus 静态站（`pnpm build` → `build/`），同样可以直接托管到 Vercel，两者互不影响：文档站不需要服务端，验证服务不需要数据库。

---

## 结构

```
api/index.ts              Vercel Serverless 入口（一个函数服务四个路径）
src/app.ts                HTTP 路由、CORS、统一错误
src/protocol.ts           挑战 / 兑换 / 校验，无状态核心
src/server.ts             本地 Node 入口 + 静态托管
public/widget.js          自定义元素 <nscha-widget>，单文件零构建
public/nscha-solver.js    同源求解器（同步脚本生成）
public/cap/*.wasm         同源求解器资源
public/index.html         部署页 / 真实演示
scripts/sync-solver.mjs   从 node_modules 同步浏览器资源
vercel.json               部署配置
```

浏览器端随仓库附带的第三方资源及许可见 `public/THIRD-PARTY.txt`。页面上不出现任何第三方产品名或署名。

---

## 诚实边界

- **一次性的是兑换，不是令牌**：`usedNonces` 是进程内记录，保证同一份挑战在**单个实例**内只能兑换一次；跨实例时真正兜底的是短时效、签名与用途绑定。兑换令牌在有效期内不做全局一次性消费。
- 这正好是无服务器部署的代价：不引入共享存储，就不可能有全局去重。**想清楚再调大 `CAP_TOKEN_TTL_SECONDS`**。
- `ALLOWED_ORIGIN` 默认 `*` 是为了让任何人都能先试起来；生产环境请收敛，否则别人可以白用你的算力。

完整协议说明见文档站 `https://nscha.nsbbs.eu.cc`。
