# 均成智能官网 · junchengzn.com

极简黑白 + 电光蓝（#0066F5）单页官网。纯静态站点，无框架、无构建，Caddy 直接托管。

## 目录结构

```
junchengzn.com/
├── index.html            # 首页（单页滚动叙事，含 og:image 分享卡片）
├── 404.html              # 品牌 404 页
├── weixin.html           # /weixin 短链页（微信二维码）
├── blog/
│   ├── index.html        # 洞察文章列表页
│   └── posts/
│       ├── ai-fanchuan.html        # AI 翻车实录
│       ├── kuaijing-agent.html     # 跨境 Agent 落地
│       └── rag-jiansuo.html        # RAG 向量检索
├── assets/
│   ├── css/style.css     # 全站样式
│   ├── css/blog.css      # 博客文章样式
│   ├── js/main.js        # 交互（滚动淡入/数字计数/导航/移动菜单）
│   └── img/
│       ├── favicon.svg   # 站点图标（电光蓝 + "均"）
│       ├── og-image.png  # 微信/飞书分享卡片（1200×630）
│       └── wechat-qr.png # 微信二维码（玩Ai的阿杜）
├── robots.txt
├── sitemap.xml
├── Caddyfile             # 服务器部署配置（主域/www/blog 子域名）
└── README.md
```

## 上线后维护清单

- ✅ **微信二维码**：`assets/img/wechat-qr.png`（玩Ai的阿杜），已上线。
- ✅ **联系方式**：电话 `187 8911 6057`、邮箱 `2192727383@qq.com`（页脚 + CTA）。
- ✅ **备案**：服务器为香港节点，免 ICP 备案，页脚不展示备案号。
- ✅ **产品下载**：进销存桌面版 v0.3.2（`/download/general-inventory-setup-0.3.2.exe`，源文件在
  `C:\Users\Administrator\Desktop\库存管理\AI智能管理进销存系统\release\`）+ 手机版 APK v1.0.0。
- **内容更新**：数据板块（#stats）与洞察列表（#insights）随业务进展更新，
  数字直接改 `data-count` 属性即可，滚动计数会自动适配。
- **部署同步**：改完叫 agent 同步，或手动：
  `scp -r D:\junchengzn.com\* ubuntu@43.128.20.39:/var/www/junchengzn/`

## 本地预览

```powershell
cd D:\junchengzn.com
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080
```

## 部署到服务器（43.128.20.39，Caddy）

```powershell
# 1. 上传站点文件（替换 <user> 为服务器账号）
scp -r D:\junchengzn.com\* <user>@43.128.20.39:/var/www/junchengzn/

# 2. SSH 登录服务器，把 Caddyfile 内容合并进 /etc/caddy/Caddyfile
ssh <user>@43.128.20.39
sudo mkdir -p /var/www/junchengzn
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 部署前提（一次性配置）

- **防火墙**：腾讯云控制台放行 TCP 80 与 443（当前 443 未通，HTTPS 无法签发）。
- **DNS**：为 `www.junchengzn.com` 添加 A 记录指向 `43.128.20.39`。
- **备案**：域名托管在大陆服务器对外提供 Web 服务需完成 ICP 备案；
  未备案前 80/443 可能被拦截（现在直接 IP 访问正常，域名访问需备案）。

## 设计规范（与需求一一对应）

- 黑白主色 + 唯一 accent 电光蓝 `#0066F5`，无渐变、无阴影、无装饰。
- 板块间距 140px（移动端 96px），正文行高 1.75-1.85，段落限宽 640px。
- 首屏仅 Slogan + 副标题 + 一个主 CTA；板块标题 34-52px。
- 业务卡片无边框无阴影，hover 仅上浮 5px + 浅灰底 + 箭头位移。
- 动效仅三种：滚动 fade-up、按钮 hover 缩放、数字滚动计数；已支持
  `prefers-reduced-motion` 降级。
- 结构：首屏 → 业务 → 数据 → 声音 → 洞察 → CTA → 页脚（Logo + 导航 + 版权 + 微信二维码）。
