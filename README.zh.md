# dsh-peak-hours

DSH 运行时段开关：在对话框**模式按钮右侧**加一个开关按钮，让 DSH 要么全天运行，要么**只在空闲时段运行**；
选后者时，DSH 里所有任务（**包括正在运行的任务**）在进入高峰时段时自动暂停，回到空闲时段自动继续。

> 空闲时段 = 价格减半的时段。高峰时段（北京时间）：**周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00**；
> 其余全部为空闲：00:00–09:00、12:00–14:00、18:00–24:00、周末全天、法定节假日全天。
> 调休上班的周末**仍算空闲**（规则只看"星期 + 是否法定节假日"）。

---

## 1. 界面

* 按钮挂在 composer 工具行的 `conversation.input.left` 槽位。运行时渲染顺序是
  `[＋] [模式按钮组：权限 + 计划] [本按钮] …`，所以它**紧贴模式选择按钮右侧**（证据：
  `dsh-client-ui-conversation/lib/client.js:17492-17525`）。
* 三种状态：
  | 状态 | 按钮文案 | 状态点 |
  | --- | --- | --- |
  | 全天运行 | 全天运行 | 中性 |
  | 空闲时段 · 运行中 | 空闲时段 · 运行中 | 绿 |
  | 空闲时段 · 高峰已暂停 | 空闲时段 · 已暂停 | 琥珀 |
* 点击弹出面板：两个模式选项、当前北京时间、下次切换时间 + 每秒倒计时、今日节假日、
  未知年份告警、时钟覆盖提示。数据来自宿主路由，15 秒轮询 + 页面重新可见时刷新；
  请求失败时按钮变灰显示「时段不可用」，不会影响壳。
* 说明：DSH 执行任务期间整个工具行会被框架隐藏（`hidden: activity`），这是官方行为，不是本插件造成的。

## 2. 暂停/恢复是怎么做的

宿主半边只在 `idle-only` 模式下拦两道 waterfall，`always` 模式下**完全不介入**：

1. **`agent/pre-step`（主闸门）** — 每一次模型调用之前。等待期收到 abort 会向上抛，正是宿主
   `signal.throwIfAborted()` 期望的控制流（`dsh-agent-loop/lib/index.js:905,911-919`）。
2. **`tools/pre-execute`（步内闸门）** — 每个工具真正执行之前，负责"一步跑到一半就进入高峰"的场景。
   abort 时返回宿主设计的 `{ kind: 'cancel' }`，而不是抛异常（抛异常会被判为 scheduler failure 并整步失败，
   `dsh-tools/lib/index.js:3225,3236-3240`）。

闸门语义：空闲相位进入 → 立即放行、不登记 waiter；高峰相位进入 → 登记 waiter，用**一个**计时器精确指向
`nextTransition.at`，到点重新评估并释放全部 waiter（不做高频轮询）。任务在 08:59:59 放行后，
其**下一次**落在 09:00:00 之后的闸门检查就会被扣住 —— 这就是"运行中的任务进入高峰自动暂停"的真实路径。

`llm/stream` **有意不拦**：它返回 `AsyncIterable` 而非 promise，且宿主存在绕过它的调用路径
（`preparedCall?.stream()`）；主闸门已覆盖每次模型调用前、工具闸门已覆盖步内边界，多包一层只会增加风险。

## 3. 安装 / 卸载（运行中的桌面端，热生效，**不重启**）

```powershell
# 项目根目录执行；默认 profile 取 $env:DSH_PROFILE（本机为 desktop）
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

脚本做四件事：清理历史诊断目录；把包复制进
`%DSH_HOME%\profiles\<profile>\node_modules\dsh-peak-hours`；在 `profiles\<profile>\cordis.patch.yml`
里维护一个带标记的 insert 行（**写前先用 js-yaml 校验，非法 YAML 一律拒绝写入**——补丁文件损坏会让整个
profile 停止 reconcile，任何后续改动都不再生效，只能重启恢复）；然后轮询 `/api/peak-hours/health`。

### 3.1 让一个已存在的 entry 真正生效：三条硬条件（2026-10-09 实测踩坑）

运行中的 Loader 对"已经 failed 的 entry"**不会自动重试**，而且 Node 的 ESM 模块缓存按 **URL** 生效、
在进程生命周期内不会失效。所以下面三条必须同时满足，插件才会真正挂载：

1. **入口契约**：`apply()` 必须 resolve `undefined`（或返回一个 disposer 函数）。cordis 会把插件
   `apply()` resolve 出的值当作 effect 清理句柄，返回其它对象会抛 `TypeError: Invalid effect`
   （`cordis/lib/index.js` 的 `safeCollect`，经 `Fiber._reload`）→ fiber 变 `failed`、**什么都不注册**。
   内部 surface 由另导出的 `mount()` 返回给测试用。
2. **新的模块 URL**：改了源码后要让 Loader 真正重新求值，必须让模块 URL 变化——最稳的是换一个包目录
   （`node_modules\dsh-peak-hours-live`）而不是原地改文件；原地改文件跑的还是缓存里的旧模块。
3. **新的 row id**：`fiberPhase:"failed"` 的 entry 用同 id 改配置不会重新 apply；重激活要**换一个 row id**
   （`install.ps1` 的第二阶段自动这么做，形如 `peak-hours-2601091901`）。

排查入口：`plugin_manager list_plugins` 找 `include:<row id>` 的 `fiberPhase`
（`active` 正常 / `failed` 需要按上面三条重激活 / `null` 表示模块还没解析到）。

### 3.2 本机当前的安装态（供维护参考）

正在运行的是 `profiles\desktop\node_modules\dsh-peak-hours-live`（干净未插桩的交付代码），
patch 行为 `peak-hours-live`。规范目录 `dsh-peak-hours` 也在，但本进程内不能切回它（ESM 缓存里是修复前的
旧模块）。**重启桌面端后跑一次 `install.ps1`** 即可完全归位：脚本会写回规范 row、清理 `-live` 等历史目录。

> 重启桌面端会终止当前会话；本插件全程不需要重启即可生效。

## 4. HTTP 接口（回环，无需 GUI token）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/peak-hours/health` | `{ ok, plugin, version }` |
| GET | `/api/peak-hours/state` | 状态信封（见下） |
| POST | `/api/peak-hours/mode` | `{ "mode": "always" \| "idle-only" }` |
| POST | `/api/peak-hours/clock` | `{ "offsetMs": <int\|null>, "ttlMs"?: <int> }` 时间偏移（默认 TTL 10 分钟，到点自动清除） |

```jsonc
{ "ok": true, "state": {
  "mode": "always", "phase": "idle", "reason": "off-hours",
  "now": 1791541815888, "nowText": "2026-10-09 18:30:15",
  "nextTransitionAt": 1791766800000, "nextTransitionText": "2026-10-12 09:00:00", "nextPhase": "peak",
  "msUntilTransition": 224984112, "paused": false, "waitingTasks": 0,
  "holidayToday": null, "holidayCoverage": "known", "unknownHolidayYear": null,
  "timeZone": "Asia/Shanghai (UTC+8)", "peakWindows": ["09:00-12:00", "14:00-18:00"],
  "clockOverride": null, "config": { "allowClockOverride": true } } }
```

`clockOverride` 是**测试/演示**用的时间偏移（把"现在"伪装成任意时刻，用来验证暂停/恢复），
必须带 TTL 自动过期——否则伪装成高峰后，被扣住的任务（包括发起测试的会话）可能要等到真实空闲窗口。
设 `DSH_PEAK_HOURS_ALLOW_CLOCK=0` 可整体关闭该接口。

## 5. 节假日数据

* 内置 2025（28 天）、2026（33 天）国务院办公厅放假安排，逐日列出；**调休上班日不在集合内**。
  来源（含逐条原文）见 `lib/core/holidays.js` 的 `HOLIDAY_SOURCE_DETAIL`，主源为 gov.cn 政策库/国务院公报，
  并有新华社/人民网/光明网交叉核对。
* 2027 年通知尚未发布：该年走 `holidayCoverage: "unknown"` + `unknownHolidayYear: 2027`，
  当日按**非节假日**处理（工作日窗口内仍是高峰），UI 会显示告警。发布后补一行数据即可。
* 自定义：`createCalendar({ extra: { '2027-01-01': '元旦' } })`，`extra` 优先且不受 `years` 约束。
* 两个官方口径提醒：2026 年中秋（9/25–27）与国庆（10/1–7）是**两个独立假期**；2025 年国庆+中秋为 8 天连休。

## 6. 配置

插件行可带 config（默认值即可用）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `allowClockOverride` | `true`（本机） | 是否允许 `POST /api/peak-hours/clock` |
| `version` | 读 package.json | `/health` 上报的版本 |

模式持久化在 `%DSH_HOME%\peak-hours-state.json`（原子写 + 写入串行化；文件损坏回退 `always` 并只记一条日志）。
卸载时全部监听器、计时器、路由随 fiber 一起释放，不留残留。

## 7. 已知边界

* 已经发出的一次模型调用不会被打断，任务在**下一个**安全边界（下一次 pre-step 或下一次工具执行前）暂停。
* 终端里的后台进程/`job_*` 后台 shell 不是 agent 步进，不受闸门影响（需要时请自行暂停）。
* 高峰期间提交的消息不会被丢弃，只是被扣住，回到空闲时段自动继续。

## 8. 测试与验证

```powershell
node --test "test/**/*.test.mjs"      # 作者单测（core/host/client）
node --test "verify/**/*.test.mjs"    # 独立验证（数据核对/边界/性质/闸门/对抗/真实 cordis）
node tools/smoke-host.mjs             # 无运行时依赖的宿主半边冒烟（真 HTTP + 假 ctx）
```

Node 24 下 `node --test <目录>` 会把目录当模块解析并失败，请使用上面的 glob 形式。

验证证据（原始命令与输出）见 `verify/EVIDENCE.md`，接口契约与设计裁决见 `SPEC.md`。

### 8.1 实测结论（2026-10-09，本机运行中的桌面端 0.2.0-rc.2）

| 项目 | 结果 |
| --- | --- |
| 作者侧单测 `node --test "test/**/*.test.mjs"` | **234 / 234 通过**（core 58 + host 94 + client 82） |
| 独立验证 `node --test "verify/**/*.test.mjs"` | **99 / 99 通过**（节假日逐日核对、边界矩阵、性质测试、闸门语义、对抗、真实 cordis、客户端） |
| 宿主冒烟 `node tools/smoke-host.mjs` | **SMOKE OK**（真 HTTP + 假 ctx，含入口契约回归） |
| 真机健康检查 | `GET /api/peak-hours/health` → `{"ok":true,"plugin":"dsh-peak-hours","version":"0.1.0"}` |
| 真机暂停 | 用时钟覆盖把"现在"设为 2026-10-12 09:10（高峰）→ `phase:"peak"`、`paused:true`、`waitingTasks: 2`，持续 6 秒仍持有 |
| 真机恢复 | 清除覆盖 → `paused:false`、`waitingTasks: 0`；后台金丝雀任务在被扣住约 10 秒后自动继续并跑完全部步骤 |
| 客户端挂载 | `conversation.input.left` 出现 occupant `{id:"peak-hours", order:20, active:true}`（模式按钮右侧） |
