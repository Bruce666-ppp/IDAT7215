# Pico 在线部署

公开入口为 [Pico GitHub Pages](https://bruce666-ppp.github.io/IDAT7215/)。GitHub Pages 渲染静态入口和公开示例。点击「选宠问卷」后，入口查询托管服务的健康状态，再打开该服务上的问卷。问卷、推荐、反馈、真实社区和 PDF 都在同一个 Flask HTTPS 域名下访问。

Flask 对问卷做原有特征提取，加载 `artifacts/model.pt` 进行 CPU 推理，再使用专家规则筛选并解释结果。健康接口返回模型版本和运行模式。SQLite 保存匿名会话的推荐、反馈和社区数据。

## 创建免费演示服务

1. 登录 Render，打开 [导入 Pico Blueprint](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FBruce666-ppp%2FIDAT7215)。如需授权，请选择 `Bruce666-ppp/IDAT7215`。在创建页确认服务的实例类型为 **Free**。免费档闲置后会休眠，首次访问可能需要等待约一分钟。服务重启或重新部署会清空演示记录。[Render 免费档说明](https://render.com/docs/free)
2. 服务达到 **Live** 后复制 Render 提供的 HTTPS 站点地址。访问该地址的 `/api/health`，确认 HTTP 200、`status: "ok"` 与 `model_loaded: true`。
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 设置仓库变量 `PAWTH_APP_URL`，值为该 HTTPS 站点首页地址。到 **Actions → Deploy PawthFinder to GitHub Pages → Run workflow**，选择 `main`。发布后，在公开入口点击「选宠问卷」即可进入在线推荐。

服务地址和 GitHub 仓库变量可以公开。应用的签名密钥由 Render 生成并保存在平台中。

## 运行配置

| 配置 | 用途 |
| --- | --- |
| `PORT` | 托管平台传入的 HTTP 端口。Docker 默认 10000。 |
| `PAWTH_DATA_DIR` | Render Free 使用 `/tmp/pawthfinder-demo` 保存当次运行的数据。 |
| `PAWTH_TEMPORARY_RECORDS=1` | 告知演示访客，服务重启会清空临时记录。 |
| `PAWTH_SECRET` | 稳定的 Flask 签名密钥，由 Render 生成。 |
| `PAWTH_SECURE_COOKIES=1` | HTTPS 会话使用 Secure、HttpOnly 和 SameSite=Lax。 |
| `PAWTH_BEHIND_PROXY=1` | 在 Render 的 HTTPS 代理后识别外部协议。 |
| `PAWTH_PAGES_ORIGIN` | 使用 `https://bruce666-ppp.github.io`。只有公开健康接口对该来源开放读取。 |
| `PAWTH_REQUIRE_MODEL=1` | 深度学习模型不可用时，健康接口返回 503。 |
| `PAWTH_ALLOW_TRAINING=0` | 公开实例供推理和查看图表。本地默认支持上传和训练。 |

Docker 使用 CPU PyTorch，Gunicorn 以 1 个 worker 和 4 个线程运行。应用在数据目录创建 `pawthfinder.sqlite3`。提交、反馈和 PDF 上传在 Flask 域名内完成，用户从 Pages 跳转时无需跨站 Cookie。使用带持久存储的主机时，可将 `PAWTH_DATA_DIR` 指向挂载目录并设定稳定的 `PAWTH_SECRET`。

## 接口与验证

| 路径 | 用途 |
| --- | --- |
| `GET /api/health` | 数据库和模型状态、模型版本和运行模式。 |
| `GET /api/info` | 问卷默认值、宠物档案和模型版本。 |
| `POST /api/recommend` | 真实模型评分、规则筛选和按会话保存的推荐记录。 |
| `POST /api/feedback` | 为当前匿名会话的某次推荐保存或更新评分。 |

本地使用 `python -m pip install -r requirements.txt`、`python app.py` 和 `python -m pytest -q`。用 `python build_pages.py --app-url https://你的服务域名` 可以构建包含线上入口的静态预览。

部署后，在浏览器中通过公开入口提交两份不同的问卷并为其中一次保存评分。检查结果中的模型版本，再使用独立浏览器会话验证历史和评分隔离。

后续把修改推送到 `main` 后，Render 与 GitHub Actions 会使用同一仓库更新各自的部署。
