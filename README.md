# Mineradio Docker / NAS（lmh 版）

基于 [lmh200609/Mineradio-LX-qs](https://github.com/lmh200609-commits/Mineradio-LX-qs)（纯 Node 服务 + Electron 桌面壳）改造而来的 **Docker / NAS 音乐播放器服务端**。去掉了 Electron 桌面壳，直接用 `node server.js` 跑在容器里，适配飞牛 fnOS 等 NAS 场景。

> 许可证：**GPL-3.0**。上游署名见 `NOTICE.md`（XxHuberrr/Mineradio 主线 + rebindd/mineradio-web 复刻参考 + lmh200609/Mineradio-LX-qs）。

## 功能

| 能力 | 说明 |
| --- | --- |
| 🎵 3D 视觉播放器 | Three.js 粒子 / 歌单架场景，随频谱跳动；网页 / Docker 版**默认开启 DIY 视觉模式**（视觉控制台 `#fx-panel` + 悬浮按钮默认显示，Splash 约 1.1s 后自动跳过，无需手动点击） |
| 📂 本地音乐库 | 挂载 `/music` 目录，启动 / 手动扫描后自动填入「本地音乐」歌单；`/api/local-file` 支持 Range（206）流式播放，含路径穿越防护 |
| 🌐 网易云 / QQ 音乐 | 在「账户」页填自己的登录态 cookie 即可；服务端用 `NeteaseCloudMusicApi` 实现，为**运行时依赖**（构建即安装，非可选） |
| 🎚 落雪 / LX 音源 | 在面板导入远程音源脚本（如 `https://raw.githubusercontent.com/pdone/lx-music-source/main/lx/latest.js`）后启用第三方曲库 |
| 🔌 安全 | `/api/audio` 仅放行 http(s) 绝对地址，缓解 SSRF；静态资源长缓存 + `.html` 强制 `no-cache`（杜绝「刷新仍是旧页」） |

## 快速部署（飞牛 fnOS / 任意 Docker 主机）

```bash
git clone https://github.com/okpkyes/mineradio-docker.git
cd mineradio-docker
# 按需改 docker-compose.yml 里的音乐目录挂载
docker compose up -d --build
# 浏览器打开 http://<主机IP>:8765/
```

构建说明：
- 基础镜像 `node:20-slim`；`npm ci --omit=dev` 仅装**运行时依赖**（含 `NeteaseCloudMusicApi`、`gsap`、`mpg123-decoder`），`electron` / `electron-builder` 等仅开发依赖不进镜像。
- 服务端口容器内 `3000`，compose 默认映射 `8765`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `MUSIC_ROOT` | `/music` | 本地音乐根目录（容器内路径） |
| `MINERADIO_USER_DATA_DIR` | 数据目录 | 歌单 / 登录态 / cookie 落盘位置 |
| `MINERADIO_LIBRARY_FILE` | `<data>/mineradio-library.json` | 本地歌单库文件路径 |
| `MINERADIO_LX_SOURCE_DIR` | `<data>/lx-sources` | 落雪 / LX 远程脚本缓存目录 |
| `COOKIE_FILE` / `QQ_COOKIE_FILE` | 容器内 | 网易云 / QQ 登录态 cookie 文件 |
| `MAX_SCAN_FILES` | `10000` | 本地扫描文件数上限 |

> NAS 示例（`docker-compose.yml` 已预置飞牛路径）：音乐只读挂载 `/vol1/1000/Pan/music:/music:ro`，数据卷 `mineradio-data:/data`，并以 `user: "0:0"` 运行。

## 使用

1. **本地音乐**：把歌曲丢进挂载的 `/music` 目录，面板点「扫描 / 刷新」即可在「本地音乐」歌单播放（百首级自动入库）。
2. **在线音源**：「账户」页填自己的网易云 / QQ 登录态 cookie（否则返回 `login_required`）。
3. **落雪 / LX**：在对应面板粘贴或上传远程音源脚本 URL 并导入，才有第三方曲库。
4. **视觉控制台**：网页版默认开启；点右下角 FX 按钮可调视觉效果预设、频谱灵敏度等。

## 目录结构

```
server.js                 纯 Node HTTP 服务（无 Electron 运行时依赖）
src/fs-library.js         本地目录浏览 / 递归扫描 / Range 流式（/api/library/*、/api/local-file）
desktop/library-store.js    歌单库（JSON 持久化，纯 Node）
public/                    前端（index.html + vendor：three / gsap / music-tempo）
dj-analyzer.js            DJ 分析模块
Dockerfile / docker-compose.yml
NOTICE.md / LICENSE       GPL-3.0 上游署名与许可证
```
