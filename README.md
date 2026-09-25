# 邮件工作台

一个独立运行的 macOS Apple Mail 桌面工作台。应用内置 Electron 和 Node.js，通过 osascript 执行 AppleScript，使用 Mac「邮件」应用当前已配置的账户读取邮箱、浏览邮件、查看正文、标记已读或未读，并撰写和发送邮件。

## 运行

直接打开 `/Applications/MyMail.app`，无需启动终端、安装 Node.js 或打开浏览器。需要已设置账户的 macOS「邮件」应用。

顶部菜单栏有信封图标，可打开窗口、切换“开机启动”、打开日志文件夹或退出。关闭窗口后继续在菜单栏运行，已启动的自动监听继续工作。点击“退出 MyMail”或按 Command-Q 才会完全退出。重复打开应用会回到已有窗口。

安装版首次运行默认启用开机启动；可从菜单栏关闭，也可在“系统设置 > 通用 > 登录项与扩展”中管理。登录后应用在后台启动。开发模式不会注册开机启动。开机启动仅启动应用，自动回复仍由你在界面中手动开启。

第一次读取或发送邮件时，macOS 会询问是否允许 MyMail 控制「邮件」；选择允许即可。之后可在「系统设置 > 隐私与安全性 > 自动化」中管理授权。

桌面服务使用随机本机端口及每次启动生成的访问令牌，界面使用固定的私有 `mymail://app/` 地址。服务只监听 127.0.0.1，不调用 Gmail API，也不会持久化邮件正文。读取和发送由 Apple Mail 及其已配置的邮件服务处理。

右侧自动化栏包含“调试”“自动运行”和“设置”三个标签。“自动运行”在手动启动后会自动读取新邮件、生成并发送回复。设置中的 API 端点、模型和 API 密钥继续保存在本机 `~/Library/Application Support/MyMail/settings.json`，文件权限限制为当前用户。自动回复测试会话直接使用 Apple Mail 的 `appleMessageId`，并按字符串处理以避免大整数精度丢失。

调试或邮件操作失败时，页面会显示服务端返回的原始原因、错误码、请求 ID 和可能原因；桌面日志写入 `~/Library/Application Support/MyMail/logs/mail-desk.log`，可用请求 ID 定位对应记录。测试会话由“开始监听新邮件”建立监听起点，之后只读取起点之后的邮件，刷新邮箱列表不会覆盖会话。

## 开发与打包

开发需要 Node.js 22 或更新版本。执行 `npm install` 后用 `npm start` 启动桌面应用。`npm run build:mac` 生成适合 Apple Silicon 的 `dist/mac-arm64/MyMail.app`，将它放入“应用程序”文件夹即可使用。应用包含本地 ad-hoc 签名和 Apple Events 权限声明；对外分发时需另外配置 Developer ID 签名与公证。

应用图标源代码在 `scripts/build-icons.swift`，执行 `npm run build:icons` 可重新生成彩色 `.icns` 和适配深浅菜单栏的模板图标。构建只包含运行所需文件，不会打包 `.env`、日志或本机 API 配置。

需要保留浏览器开发方式时，可运行 `npm run start:web` 并访问 http://localhost:3001。

## 功能

- 查看账户邮箱文件夹和未读数量
- 在侧栏切换 Apple Mail 账号；默认使用 Mail 返回的第一个账号，并记住上次选择
- 每个账号只显示收件箱（`INBOX`）和已发邮件
- 浏览最近的 50 封邮件，并筛选当前列表
- 阅读正文、标记已读或未读
- 撰写邮件，支持多个收件人、抄送和密送
- 自动回复测试会话：开始监听、检查新邮件、生成并发送回复
- 使用兼容 OpenAI Chat Completions 的 API 生成并发送回复

## 验证

运行 `npm test` 验证服务和现有界面。运行 `npm run test:desktop` 验证桌面窗口、私有接口、后台监听、单实例、退出清理、隐藏启动和设置持久性；桌面测试使用隔离配置和模拟邮箱，不会发送真实邮件。截图保存在 `artifacts/`。
