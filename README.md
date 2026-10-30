# wormhole

通用内网反向代理 relay —— 独立 Node.js 服务 + 管理页面，给**任意内网运行的网站/网页**做出口中转，目标网站**零改造**，只需把访问地址换成 relay 地址即可。

```
用户/浏览器 ──▶ relay（公网或外侧机器）
                 │  按「路由规则」转发
                 │  WebSocket 长连接（agent 主动连入，内网无需公网IP/端口）
              agent（内网）──▶ http://内网目标:端口（任意网站，不改代码）
```

## 组成

| 组件 | 运行位置 | 说明 |
|---|---|---|
| `server/` | 公网服务器 | 转发服务 + 路由规则管理 API + 管理页面 |
| `agent/` | 内网（能访问目标网站即可） | 主动连接 relay，把收到的请求转发给内网目标 |
| `public/` | 由 server 托管 | 管理页面（规则增删改、启停） |

## 快速开始

```bash
cd wormhole
npm install

# 1. 启动 relay（公网机器，或本机测试）
node server/index.js --port 7800 --secret my-shared-secret

# 2. 启动 agent（内网机器），注册一条路由
node agent/index.js --relay http://relay机器:7800 \
  --secret my-shared-secret \
  --name intranet-wiki \
  --target http://192.168.1.10:8090

# 3. 打开管理页启用规则
#    http://relay机器:7800/admin
```

之后外部访问 `http://relay机器:7800/p/intranet-wiki/` 即等于访问内网 `http://192.168.1.10:8090/`。

## 接入任意网站的方式

### 方式一：路径模式（默认，改 BaseURL 即可）

规则路径前缀为 `/p/{name}/`。目标网站若支持配置 BaseURL / 根路径（大多数 Wiki、文档站、内部系统都支持），把它设为 `http://relay:7800/p/{name}/` 即完成接入。

agent 会在转发时自动改写 HTML 里的绝对路径引用（`href="/..."`、`src="/..."`），帮助无 BaseURL 配置的简单站点尽量正常工作。

### 方式二：子域名模式（完全不改动感）

`--host-mode`：设置 DNS 泛解析 `*.relay.你的域名.com` 指向 relay，访问 `{name}.relay.你的域名.com` 即直达内网站点，页面完全不需要路径前缀，兼容性最好。需在 relay 侧加 `--root-domain` 参数开启。

## 支持的流量

- 普通 HTTP/HTTPS 请求（GET/POST/PUT/DELETE/PATCH，含二进制与流式响应）
- WebSocket 透传（如内网系统的实时功能）
- 请求/响应头按需透传，自动处理 `Host`、`X-Forwarded-*`

## 管理页面

`http://relay:7800/admin`

- 查看/新增/编辑/删除路由规则
- 启用/停用单条规则（停用后 relay 返回 502 提示页）
- 实时显示每条规则的连接 agent 与流量统计

## 安全建议

- `--secret` 为 server 与 agent 的共享密钥，务必使用强随机值
- 生产环境在前置一层 HTTPS（Caddy/Nginx 均可）
- 管理页默认无鉴权，只应暴露在内网或加 Basic Auth；可用 `--admin-user/--admin-pass` 开启管理页 Basic Auth

## 配置持久化

规则保存在 `--data` 目录（默认 `./relay-data/rules.json`），重启不丢失。agent 侧规则写在各自启动参数或 `agent/config.json`。
