# 沙箱设计：原生轻量后端（bubblewrap / Seatbelt / Restricted Token）

> 目标：和 Claude Code、Codex 一样 —— 默认用**内核级轻量边界**，不依赖 Docker、不要 root、
> 不要常驻守护进程；工具缺失或内核不支持时**失败关闭**，绝不静默降级到纯策略层。

代码入口：

| 文件 | 职责 |
|---|---|
| `src/sandbox.js` | 策略层（作用区域 / 只读 / 命令扫描 / 环境清洗 / 审计）+ 后端调度 |
| `src/sandbox/bwrap.js` | Linux bubblewrap：可用性探测 + argv 计划构建（纯函数，可单测） |
| `src/sandbox/seatbelt.js` | macOS sandbox-exec：SBPL profile 生成 |
| `src/sandbox/probe.js` | 可执行文件探测与缓存（所有后端共用） |
| `native/windows-sandbox/` | Windows Restricted Token + ACL + Job Object 的 C# 执行器 |

## 1. 后端矩阵

| 平台 | 默认后端 | 机制 | 需要什么 |
|---|---|---|---|
| Linux | `bwrap` | namespace + bind mount | `bubblewrap`；白/黑名单额外需要 `socat` |
| macOS | `seatbelt` | sandbox-exec（Seatbelt） | 系统自带 |
| Windows | `windows` | 受限令牌 + capability SID ACL + Job Object | 系统自带 PowerShell |
| 任意 | `local` | 纯策略：路径作用域 + 命令扫描 + 环境清洗 | 无，但**可被绕过，只作兜底** |
| 任意 | `docker` / `wsl` | 容器 / 子系统 | 可选重方案 |

`defaultBackend()` 决定平台默认值；`SANDBOX_BACKEND` 可覆盖。后端不可用 =
**明确报错并拒绝执行**（`SandboxError`，rule=`backend`）。

## 2. Linux：bubblewrap

一次 `run_shell` 实际生成的边界（`buildBwrapPlan`）：

| 边界 | 参数 | 语义 |
|---|---|---|
| 读 | `--ro-bind / /` | 整个文件系统只读可见（与 Claude Code / Codex 同语义） |
| 写 | `--bind <root> <root>` | 只有授权根目录可写；`scope=full + write` 直接拒绝 |
| 临时目录 | `--bind <private> /tmp` | `/tmp` 换成私有目录，宿主 `/tmp` 不进沙箱；每条命令前清空 |
| 进程 | `--unshare-pid --unshare-uts --unshare-ipc`、`--die-with-parent`、`--new-session` | 独立 PID/IPC/UTS，父进程退出整棵树收走，防 TIOCSTI 注入 |
| 设备 | `--dev /dev`、`--tmpfs /dev/shm` | 干净的 `/dev` 与私有共享内存 |
| 网络 `off` | `--unshare-net` | 沙箱里没有对外网卡（lo 除外） |
| 网络 `all` | （无） | 共享宿主网络 |
| 网络白/黑名单 | `--unshare-net` + `--ro-bind <proxy.sock>` + 沙箱内 `socat` 桥 | 唯一出网通道是宿主策略代理 |
| 进程数 | `ulimit -u <pidsLimit>` | 内核不提供 cgroup 配额，进程数用 ulimit 兜底 |

已知偏差（不假装）：

* **没有内存/CPU 配额**：bwrap 不是 cgroup，`SANDBOX_MEMORY`/`SANDBOX_CPUS` 在 bwrap 下不生效，
  `describe().limitsEnforced` 会如实标注。
* **只读模式不给可写 `/tmp`**：项目只读语义是「一个字节都不许落盘」。
* **`/tmp` 覆盖优先级**：可写根先 bind，`/tmp` 后 bind；即使 roots 里包含 `/tmp`，沙箱里它也是私有目录。

## 3. 网络：三种强制力

| 形态 | 后端 | 能不能绕 |
|---|---|---|
| 内核断网 | bwrap（`--unshare-net`）、Seatbelt（不 allow `network*`）、Docker（`--network none`） | 不能 |
| 强制代理桥 | bwrap + 白/黑名单 | 不能：沙箱内只有一个 unix socket 通道，socat 把它桥到按策略放行的代理 |
| 合作式代理 | windows / wsl / local | 能：程序自己实现网络栈、无视 `HTTP(S)_PROXY` 直连即可绕过（界面如实标注） |

代理桥细节：宿主代理监听一个 unix socket（`getNetworkProxy(policy, { unixSocketPath })`），
socket 路径按「会话 + 策略」稳定生成并挂在 `/run/user/<uid>`（拿不到 `XDG_RUNTIME_DIR` 时退回
项目内 `.sandbox-tmp/net`，绝不放在宿主 `/tmp` —— 那里会被沙箱内的私有 `/tmp` 盖掉）。
沙箱内 `socat TCP-LISTEN:3128` 把本地回环端口桥到该 socket，环境变量指向 `127.0.0.1:3128`。

## 4. macOS：sandbox-exec

生成的 SBPL profile（`buildSeatbeltProfile`）结构固定：

```
(version 1)
(deny default)
(allow process-fork) (allow process-exec*) (allow process-info*)
(allow signal (target self)) (allow sysctl-read) (allow mach-lookup) (allow ipc-posix-shm)
(allow file-read*)                         ; 读全域
(allow file-write* (subpath "<root>") …)   ; 只写授权根目录 + 临时目录
(allow file-write-data (literal "/dev/null") …)
(allow network*)                           ; 仅 all 模式
```

Seatbelt 无法按主机名过滤网络，所以 `whitelist` / `blacklist` 在创建沙箱时直接报错，
不会假装规则生效。用户命令以 argv 传给 `/bin/sh -c`，profile 不掺任何用户输入。

## 5. 探测与失败关闭

* `bwrapAvailable()` 不只看装没装，而是真跑一次「只读根 + 新 PID namespace」的最小沙箱
  —— Ubuntu 23.10+ 的 AppArmor 限制、容器内缺权限都会在这里暴露。
* `seatbeltAvailable()` 看系统是否有 `sandbox-exec`。
* `docker`/`wsl` 分别跑 `docker info`、`wsl -e sh -c 'exit 0'`。
* 探测结果缓存；`backendAvailable` / `backendCatalog()` 同时供 API、界面、启动日志使用。

## 6. 与策略层的关系（纵深防御）

内核后端只负责**写入边界与进程/网络边界**；`src/sandbox.js` 的策略层继续工作：

1. 文件工具的路径先过 `sandbox.resolve()`（`scope=full` 除外），只读模式下拒绝写。
2. `run_shell` 的命令先过 `checkCommand()`：危险命令、只读写类命令、网络策略、越界路径
   （`SANDBOX_STRICT=0` 可关掉最后一项，危险命令仍硬拦）。
3. 环境变量清洗：只给白名单变量，`HOME` 指向作用区域，API key 不进子进程。
4. 每次放行/拒绝都进 `auditLog`，拒绝发 `sandbox_denied` 事件，界面与会话接口可查。

分层理由与 Claude Code 一致：内核沙箱管「碰得到什么」，策略/审批管「要不要做」。

## 7. 明确不做的事

* 不提供读取保密（Linux/macOS 是「读全域、写白名单」）。
* 不做 GUI/桌面会话隔离。
* 不把 `local` 伪装成安全边界；`docker`/`wsl` 只要配置了就会如实标注等级。
* 不在后端不可用时静默回落。

## 8. 测试

```bash
node scripts/sandbox-test.js         # 跨平台：作用区域/权限/命令扫描/后端计划构建/审计/界面
node scripts/linux-sandbox-test.js   # Linux 真机：越权写被 EROFS 拒绝、off 无对外网卡、白名单桥、PID namespace
node scripts/macos-sandbox-test.js   # macOS 真机：越权写被拒、只读不落盘、off 断网
node scripts/windows-sandbox-test.js # Windows 真机：受限令牌写入边界、Job Object 进程树
node scripts/sandbox-breach-test.js  # 用真实的逃逸尝试给 local 后端打分（它本来就挡不住）
```
