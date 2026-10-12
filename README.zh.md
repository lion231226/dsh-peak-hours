# dsh-peak-hours

DeepSeek Harness（dsh）的运行时段开关：在对话框**模式按钮右侧**加一个控件，让 dsh 要么全天运行，
要么**只在空闲时段运行**；选后者时，所有任务（**包括正在运行的任务**）在进入高峰时段时自动暂停，
回到空闲时段自动继续。

English documentation: [README.md](README.md)

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 运行时段规则

空闲时段就是价格减半的时段。高峰时段（北京时间 UTC+8）为：

| 时段 | 相位 |
| --- | --- |
| 周一至周五 09:00–12:00、14:00–18:00，**不含中国法定节假日** | 高峰 |
| 其余全部：00:00–09:00、12:00–14:00、18:00–24:00、周末全天、法定节假日全天 | 空闲 |

调休上班的周末**仍算空闲**——规则只看"星期 + 是否法定节假日"，不引入调休表。

## 安装

### 方式一：dsh CLI

```sh
dsh plugin --profile web add github:lion231226/dsh-peak-hours
```

插件是纯 JavaScript、无构建步骤、无运行时依赖，源码安装即可用。仓库的 Release 里也附了预构建
tarball（`dsh-peak-hours-0.1.1.tgz`），插件市场会优先用它。

### 方式二：`install.ps1`（运行中的桌面端，热生效，**不需要重启**）

```powershell
# 在仓库根目录执行；profile 默认取 $env:DSH_PROFILE
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

脚本做四件事：清理历史诊断目录；把包复制进
`%DSH_HOME%\profiles\<profile>\node_modules\dsh-peak-hours`；在 `profiles\<profile>\cordis.patch.yml`
里维护一个带标记的 insert 行（**写前先用 js-yaml 校验，非法 YAML 一律拒绝写入**——补丁文件一旦损坏，
整个 profile 会停止 reconcile，后续任何改动都不再生效，只能重启恢复）；然后轮询
`/api/peak-hours/health` 确认插件真的起来了。

> **两种安装方式不要混用。** `dsh plugin add` 会把包登记为 profile bundle，由 bundle 层贡献它自己
> `cordis.patch.yml` 里的 patch 行；`install.ps1` 则是手工往 profile 的 patch 文件里写这一行。
> 对一个已登记 bundle 的 profile 再跑本脚本，会留下两条同 id 的 entry——补丁应用与 cordis Loader
> 都不做去重（`dsh-app-boot` 的 insert 是直接 push，`cordis-plugin-loader` 没有重复检查），
> 重启时有真实风险。脚本现在检测到这种情况会直接拒绝执行。

#### 让一个已存在的 entry 真正生效：三条硬条件

运行中的 Loader 对"已经 failed 的 entry"**不会自动重试**，而 Node 的 ESM 模块缓存按 **URL** 生效、
在进程生命周期内不失效。所以下面三条必须同时满足，插件才会真正挂载（这也是 `install.ps1`
第二阶段会自动换一个 row id 的原因）：

1. **入口契约**：`apply()` 必须 resolve `undefined`（或返回一个 disposer 函数）。cordis 会把插件
   `apply()` resolve 出的值当作 effect 清理句柄，返回其它对象会抛 `TypeError: Invalid effect`
   （`cordis` 的 `safeCollect`，经 `Fiber._reload`）→ fiber 变 `failed`、**什么都不注册**。
   内部的 surface 由另导出的 `mount()` 返回给测试用。
2. **新的模块 URL**：改了源码后要让 Loader 真正重新求值，必须让模块 URL 变化——最稳的是换一个包目录，
   原地改文件跑的还是缓存里的旧模块。
3. **新的 row id**：`fiberPhase: "failed"` 的 entry 用同一个 id 改配置不会重新 apply；重激活要**换一个
   row id**（`install.ps1` 第二阶段会写成 `peak-hours-<时间戳>`）。

排查入口：`plugin_manager list_plugins` 找 `include:<row id>` 的 `fiberPhase`
（`active` 正常 / `failed` 需要按上面三条重激活 / `null` 表示模块还没被解析到）。

## 界面

* **按钮**挂在 composer 工具行的 `conversation.input.left` 槽位。运行时渲染顺序是
  `[＋] [模式按钮组：权限 + 计划] [本按钮] …`，所以它**紧贴模式选择按钮右侧**
  （依据：`dsh-client-ui-conversation/lib/client.js:17492-17525`）。
* 三种状态：

  | 状态 | 按钮文案 | 状态点 |
  | --- | --- | --- |
  | 全天运行 | 全天运行 | 中性 |
  | 空闲时段 · 当前空闲 | 空闲时段 · 运行中 | 绿 |
  | 空闲时段 · 当前高峰 | 空闲时段 · 已暂停 | 琥珀 |

* **弹层**：两个模式选项、当前北京时间、下次切换时间 + 每秒倒计时、今日节假日、未知年份告警、
  时钟覆盖提示。
* **队列横幅**：处于「仅空闲时段」且当前是高峰时，输入卡片上方出现一行提示，写明已排队的任务数与
  「将在 12:00:00 自动开始」，倒计时每秒本地跳动。不满足条件时**完全不占位**。
* 状态数据来自宿主路由：常规 15 秒轮询，**边界前后 30 秒自动降到 3 秒**；页面重新可见时立即刷新。
  跨越边界后客户端会**本地翻转相位**，倒计时改为「正在刷新…」，不会显示负数。
* 说明：dsh 执行任务期间整个工具行会被框架隐藏（`hidden: activity`），这是官方行为，不是本插件造成的。

## 暂停/恢复是怎么做的

宿主半边只在 `idle-only` 模式下拦两道 waterfall，`always` 模式下**完全不介入**：

1. **`agent/pre-step`（主闸门）** —— 每一次模型调用之前。等待期间收到 abort 会向上抛，正是宿主
   `signal.throwIfAborted()` 期望的控制流（`dsh-agent-loop/lib/index.js:905,911-919`）。
2. **`tools/pre-execute`（步内闸门）** —— 每个工具真正执行之前，负责"一步跑到一半就进入高峰"的情况。
   abort 时返回宿主设计的 `{ kind: 'cancel' }` 而不是抛异常（抛异常会被判为 scheduler failure 并让整步失败，
   `dsh-tools/lib/index.js:3225,3236-3240`）。

闸门语义：空闲相位进入 → 立即放行、不登记 waiter；高峰相位进入 → 登记 waiter，用**一个**计时器精确指向
`nextTransition.at`，到点重新评估并释放全部 waiter（不做高频轮询）。任务在 08:59:59 放行后，
其**下一次**落在 09:00:00 之后的闸门检查就会被扣住——这就是"运行中的任务进入高峰自动暂停"的真实路径。

`llm/stream` **有意不拦**：它返回 `AsyncIterable` 而非 promise，且宿主存在绕过它的调用路径
（`preparedCall?.stream()`）；主闸门已覆盖每次模型调用前、工具闸门已覆盖步内边界，多包一层只会增加风险。

等待期间**什么都不丢**：消息与工具调用都在会话日志里，不会发出模型请求，而且等待是可 abort 的
（点停止即刻取消）。

## HTTP 接口（回环，无需 GUI token）

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
必须带 TTL 自动过期——否则伪装成高峰后，被扣住的任务（包括发起测试的会话）可能要一直等到真实空闲窗口。
设 `DSH_PEAK_HOURS_ALLOW_CLOCK=0` 可整体关闭该接口。

`waitingTasks` 是**宿主全局**的闸门等待数，可能包含其他会话在跑的任务。

## 节假日数据

* 内置 2025（28 天）、2026（33 天）国务院办公厅放假安排，逐日列出；**调休上班日不在集合内**。
  来源（含逐条原文）见 `lib/core/holidays.js` 的 `HOLIDAY_SOURCE_DETAIL`，主源为 gov.cn 政策库/国务院公报，
  并有新华社/人民网/光明网交叉核对。
* 2027 年通知尚未发布：该年走 `holidayCoverage: "unknown"` + `unknownHolidayYear: 2027`，
  当日按**非节假日**处理（工作日窗口内仍是高峰），界面会显示告警。发布后补一行数据即可。
* 自定义：`createCalendar({ extra: { '2027-01-01': '元旦' } })`，`extra` 优先且不受 `years` 约束。
* 两个官方口径提醒：2026 年中秋（9/25–27）与国庆（10/1–7）是**两个独立假期**；2025 年国庆+中秋为 8 天连休。

## 配置

插件行可带 config（默认值即可用）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `allowClockOverride` | `true` | 是否允许 `POST /api/peak-hours/clock` |
| `version` | 读 package.json | `/health` 上报的版本 |

模式持久化在 `%DSH_HOME%\peak-hours-state.json`（原子写 + 写入串行化；文件损坏回退 `always` 并只记一条日志）。
卸载时全部监听器、计时器、路由随 fiber 一起释放，不留残留。

## 已知边界

* 已经发出的一次模型调用不会被打断，任务在**下一个**安全边界（下一次 pre-step 或下一次工具执行前）暂停。
* 终端里的后台进程 / `job_*` 后台 shell 不是 agent 步进，不受闸门影响（需要时请自行暂停）。
* 高峰期间提交的消息不会被丢弃，只是被扣住，回到空闲时段自动继续。

## 测试与验证

```sh
node --test                          # 作者套件 + 独立验证套件
node --test "test/**/*.test.mjs"     # 作者套件（core 排期内核 / host 闸门与路由 / client）
node --test "verify/**/*.test.mjs"   # 独立验证套件
node tools/smoke-host.mjs            # 宿主半边对假 ctx 的真 HTTP 冒烟
node tools/show-monday.mjs           # 打印某一天的相位分段
```

`verify/` 里的独立验证套件按同一份契约另写一遍：节假日逐日核对（对照国务院通知原文）、
一秒分辨率的边界矩阵、转移函数的性质测试、假时钟下的闸门语义、对抗用例、客户端 bundle 检查，
以及在**真实 cordis 运行时**下挂载插件的 harness。逐条命令与原始输出见 `verify/EVIDENCE.md`，
接口契约与设计裁决见 `SPEC.md`。

Node 24 下 `node --test <目录>` 会把目录当模块解析并失败，请使用上面的 glob 形式。

### 实测结论（2026-10-09，运行中的桌面端 dsh 0.2.0-rc.2）

| 项目 | 结果 |
| --- | --- |
| 全量 `node --test` | **403 / 403 通过**（core 58 + host 94 + client 148 + 独立验证 99 + 其他 4） |
| 宿主冒烟 `node tools/smoke-host.mjs` | **SMOKE OK**（真 HTTP + 假 ctx，含入口契约回归） |
| 真机健康检查 | `GET /api/peak-hours/health` → `{"ok":true,"plugin":"dsh-peak-hours","version":"0.1.0"}` |
| 真机暂停 | 用时钟覆盖把"现在"设为 2026-10-12 09:10（高峰）→ `phase:"peak"`、`paused:true`、`waitingTasks: 2`，持续 6 秒仍持有 |
| 真机准点恢复 | 边界前 2 秒仍 `waitingTasks: 2`，模拟时间跨过 12:00:00 的瞬间变 `waitingTasks: 0`、`phase:"idle"` |
| 行为侧证据 | 后台金丝雀任务在被扣住约 10 秒后自动继续，4 步全部跑完 |
| 客户端挂载 | `conversation.input.left` 出现 occupant `{id:"peak-hours", order:20, active:true}`；队列横幅挂在 `conversation.input.dock`，`order:30` |
| **真实时钟验证（非模拟、无覆盖）** | 2026-10-12 周一 09:01:58（上午高峰内）提交的消息被扣住 **178 分钟**：会话日志显示消息在 `09:01:58.530` 进入 inbox、2 毫秒后 turn 开始，随后**直到 `12:00:03.051` 才出现下一条事件**（`step/start`），即 12:00:00 边界后 3 秒；模型请求在 `12:00:03.054`。消息未丢失、区间未被跳过——它就是等窗口结束 |

## 许可

MIT
