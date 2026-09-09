# 内网安装指南

本文写给在**没有公网**或**只有内网镜像**的机器上部署本系统的人。

交付包 `solution\` 是**源码交付**（约 3.6 MB）：它不含 Node.js 运行时、依赖包和两个 Agent 引擎，
这三样需要在目标机器上装一次。装完之后，之后每次启动都不再需要网络。

> 为什么不直接发全量包：全量包 355 MB，其中 `opencode.exe` 单文件 171 MB、`node.exe` 88 MB，
> 超过常见 Git 托管平台 100 MB 的单文件上限，无法随仓库分发。

---

## 1. 需要准备什么

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10 / 11 x64 | |
| PowerShell | 系统自带 5.1 即可 | 不需要 PowerShell 7 |
| Node.js | 24.19 或更高（同一大版本内） | 见第 2 步，可自带也可让脚本装 |
| npm 源 | 内网镜像地址 | 见第 3 步 |
| 磁盘 | 约 600 MB | 引擎二进制较大 |
| 管理员权限 | **不需要** | |

解压到**不含空格的短路径**，例如 `D:\pnp`，然后：

```powershell
Set-Location D:\pnp\solution\code
```

后面所有命令都在这个目录里执行。PowerShell 中执行当前目录的程序必须带 `.\`。

---

## 2. 准备 Node.js

脚本按这个顺序找 Node，**任何一步成功就不再往下走**：

```text
PNP_NODE_HOME  ->  runtime\bootstrap\node-v24.19.0-win-x64  ->  PATH 上的 node（24.19+）  ->  下载
```

三选一：

**方式 A：机器上已有合适的 Node（推荐）**

```powershell
node --version          # 需要 v24.19.0 或更高，且仍是 24.x
```

已满足就什么都不用做，脚本会直接用 PATH 上的这个。

**方式 B：指定一个已安装的 Node 目录**

```powershell
$env:PNP_NODE_HOME = 'D:\tools\node-v24.19.0-win-x64'
```

该目录下必须有 `node.exe`。

**方式 C：让脚本从内网镜像下载**

```powershell
$env:PNP_NODE_DOWNLOAD_URL = 'http://mirror.intranet.example/nodejs/node-v24.19.0-win-x64.zip'
```

脚本会下载并校验 SHA-256，解压到 `runtime\bootstrap\`。镜像上放的必须是官方同一份 ZIP，
否则校验会失败并终止（这是有意的：不校验就等于接受任意二进制）。

---

## 3. 配置 npm 内网源

脚本尊重标准的 `npm_config_registry`，**不需要改本系统任何代码**：

```powershell
$env:npm_config_registry = 'http://npm.intranet.example/repository/npm-group/'
```

需要认证或代理时，用 npm 自己的标准配置即可，脚本不做任何拦截：

```powershell
npm config set registry http://npm.intranet.example/repository/npm-group/
npm config set //npm.intranet.example/repository/npm-group/:_authToken <token>
$env:HTTP_PROXY  = 'http://proxy.intranet.example:8080'
$env:HTTPS_PROXY = 'http://proxy.intranet.example:8080'
```

验证源通不通：

```powershell
npm view opencode-ai@1.18.29 version
```

打印 `1.18.29` 即说明镜像可用。

---

## 4. 一条命令装好

```powershell
.\pnp.cmd bootstrap --engine opencode
```

它按顺序做四件事，**每件事已经满足就跳过**：

| 步骤 | 做什么 | 跳过条件 |
|---|---|---|
| Node | 按第 2 步的顺序找到或装好 Node | 已找到合适版本 |
| 依赖 | `npm ci`（读 `package-lock.json`，版本完全锁定） | `node_modules` 与锁文件指纹一致 |
| 编译 | `npm run build` 生成 `dist\` | `dist\` 与源码指纹一致 |
| 引擎 | 从 npm 装引擎到 `runtime\bootstrap\engines\<id>\<版本>\` | 该版本已存在 |

第二个引擎同样装一次：

```powershell
.\pnp.cmd bootstrap --engine pi
```

两个引擎的版本是锁定的，不会装成别的版本：

| 引擎 | npm 包 | 版本 |
|---|---|---|
| opencode | `opencode-ai` | 1.18.29 |
| pi | `@earendil-works/pi-coding-agent` | 0.85.1 |

成功后目录长这样：

```text
solution\code\
  dist\                                   编译产物
  node_modules\                           运行依赖
  runtime\bootstrap\
    node-v24.19.0-win-x64\                （方式 C 才有）
    engines\opencode\1.18.29\
    engines\pi\0.85.1\
```

---

## 5. 装不了 npm 时的替代路径

内网完全没有 npm 镜像时，可以在**一台能上网的机器上**装好，再把目录整体拷过来，或者直接指向
一份已有的安装：

| 变量 | 指向 | 用于 |
|---|---|---|
| `PNP_OPENCODE_EXE_PATH` | `...\opencode-windows-x64\bin\opencode.exe` | opencode |
| `PNP_PI_ENTRY` | `...\@earendil-works\pi-coding-agent\dist\bundle\cli.js` | pi |
| `PNP_PI_NODE` | `node.exe` 的绝对路径 | pi 需要解释器执行上面那个入口 |

设了这些变量，脚本就不再尝试安装对应引擎。

依赖同理：在联网机器上 `npm ci` 之后，把整个 `node_modules\` 和 `dist\` 拷到内网机器的
`solution\code\` 下即可，无需再联网。

---

## 6. 验证装好了

```powershell
.\pnp.cmd selfcheck --engine opencode
.\pnp.cmd selfcheck --engine pi
```

各打印 `[pnp] SELFCHECK PASS (engine=…)` 即成功。这一步**不需要模型**，用内置的模拟模型把
建会话、事件流、任务、工具授权、中止、并发全跑一遍。

配好模型后再跑一次真实链路（模型配置见 [`USAGE.md`](USAGE.md) 第 2 节）：

```powershell
.\pnp.cmd livecheck --engine opencode
```

打印 `[pnp] LIVECHECK PASS` 即整条链路通。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm.cmd was not found …` | PATH 上没有 npm | 装 Node.js，或设 `PNP_NODE_HOME` 指向含 `npm.cmd` 的目录 |
| npm 装包超时或 404 | 镜像地址不对或未认证 | 用第 3 步的 `npm view` 验证；确认 `_authToken` |
| Node ZIP 校验失败 | 镜像上不是官方那一份 | 换官方同版本 ZIP，或改用方式 A / B |
| `dist\main.js is missing or out of date …` | 改过 `src\` 但没有开发依赖 | `npm install` 后重跑 `bootstrap` |
| `INSTANCE_LOCKED` | 上一个网关进程还在 | `.\pnp.cmd stop` |
| 引擎装好了但启动报 `ENGINE_EXECUTABLE_NOT_FOUND` | 安装目录与预期不符 | 用第 5 步的变量直接指向可执行文件 |

---

## 8. 之后每次启动

装好后不再需要网络，也不再需要 `bootstrap`：

```powershell
.\gateway.cmd --engine opencode --port 6217
```

完整的启动、配置与接口调用见 [`USAGE.md`](USAGE.md)。
