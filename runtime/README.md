# runtime/ —— 项目自带的运行时

这个目录用来放**项目自己的 JS 运行时**（Bun），这样别人下载项目后不需要另外装任何东西。

```
runtime/
  bin/bun.exe     ← Windows
  bin/bun         ← Linux / macOS
  VERSION         ← 装的是哪个版本、从哪来的
```

二进制不进 git（`.gitignore` 已排除，80MB 不适合放仓库），但**可以随项目压缩包一起分发**。

## 三种拿到运行时的方式

| 场景 | 做法 |
|---|---|
| 用户机器上已经有 Node | 什么都不用做，`run.cmd` / `run.sh` 会直接用 Node |
| 用户机器上什么都没有 | 直接跑 `run.cmd` / `run.sh`，首次会下载一次 Bun 到这个目录（约 30-38MB），之后不再下载 |
| 你想打包发给别人 | 先在本机执行下面的命令，再把整个项目目录（含 `runtime/`）压缩发出去，对方双击即用、零下载 |

```bash
# ① 把本机已装的 bun 复制进来（适合打包分发）
node scripts/setup-runtime.js --bundle

# ② 或者直接下载官方发行版（自动校验 SHA256）
node scripts/setup-runtime.js

# ③ 看看现在是什么状态
node scripts/setup-runtime.js --check
```

Windows 上如果连 Node 都没有，`run.cmd` 会用系统自带的 PowerShell 执行
`scripts/setup-runtime.ps1` 完成同样的下载 + 校验 + 解压，无需额外安装。
