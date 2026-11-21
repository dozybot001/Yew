# The system sandbox / 系统沙箱

What a session's commands can and cannot do in Yew Harness, and what happens when the sandbox cannot start. English first, Chinese below. To report a security problem, see [SECURITY.md](../SECURITY.md).

会话的命令在 Yew Harness 里能做什么、不能做什么，以及沙箱起不来时怎样。先英文、后中文。报告安全问题见 [SECURITY.md](../SECURITY.md)。

## English

Sessions' commands and the MCP servers you add run in a system sandbox. It is Anthropic's open-source [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (Apache-2.0), on Seatbelt on macOS and on bubblewrap on Linux. In the sandbox, a command:

- can neither read nor change Yew Harness's data folder (your decisions, sign-in tokens and logs) or what macOS keeps for the Mac app's window (its sign-in cookie and cache), and cannot read the keychain's items;
- writes only in the session's workspace, any writable extra folders configured for that session, temporary folders and the sandbox's own caches, not in files such as `~/.zshrc` or `~/.gitconfig`, nor in any repository's hooks and settings;
- cannot change Yew Harness's program or what starts at login, and cannot reach its local port, other local ports or the local network;
- reaches only the usual package registries, GitHub, Gitee, the model providers that have a key, global domains you allow under Startup → Sandbox allowed domains, and per-session domains allowed for that session; for any other site you are asked first (and when the caller is clear, you can choose Always allow for that session);
- cannot read credential files such as `~/.ssh`, `~/.aws` or `~/.netrc`, nor use ssh-agent, unless you allow it under Startup in the settings;
- cannot read the folders listed under Default settings → Folders sessions cannot read, which sessions' file tools and commands outside the sandbox cannot read either;
- on Linux, cannot reach local Unix sockets, the D-Bus session bus included.

On Linux, a repository made while a command runs is not protected until the command ends; then Yew Harness moves any new hook aside, so git does not run it, and says so in the command's output.

A command that has to run outside the sandbox (a `git push` with credentials from the keychain, a dev server that listens on a local port, an Xcode build) is a permission: the default mode asks you every time, the automatic mode leaves it to the check first, and skip mode runs it and marks it in the record. git run outside runs no repository hooks. A command outside the sandbox still runs in an outer guard, so a session cannot use it to answer a decision in your place: it cannot read or write Yew Harness's data folder, the place where the Mac app keeps its sign-in, or the folders you keep from sessions, cannot start programs outside the guard (`open`, `osascript` telling another program), and cannot write what later runs by itself: shells' start-up files, git's and ssh's settings, repositories' hooks and settings. Nothing else is closed. Two single-purpose operations — initializing/cloning/configuring a local repository (`git init`, `git clone`, `git remote add`, `git config --local`, run in the working folder or with one `git -C` and the full path of a folder the session may write) and launching a desktop app (`open -a`) — are asked about every time in the default and automatic modes (never rememberable, and not left to the automatic check), and run without asking in skip mode: only for a single static command of that kind does the outer guard relax that one check (`.git/config` with `GIT_TEMPLATE_DIR=""` and a post-run audit of `.git/config` for executable hooks/filters, or `lsopen` alone while all file locks and `appleevent-send` stay closed); compound commands, dynamic commands and `git config --global` never relax the guard. To open an address in a browser, a session uses the `open_url` tool. The guard does not close the keychain or the system's service manager, so Yew Harness's own command line, which manages your keys and the background service, is a permission like the others: asked about in the default and automatic modes, not in skip mode. Where the guard cannot start, running outside the sandbox, a command that names Yew Harness's data or a folder you keep from sessions, and Yew Harness's command line are asked about in every mode, skip included. The built-in browser and computer control do not run in the sandbox: the browser reads and writes files only in its own empty folder, cannot open `file://` pages, and is kept off Yew Harness's own address: a call that names it is refused, and in your own Chrome no browser tool runs while a shared tab has Yew Harness open. The browser tool that runs code in the browser server's own process (`browser_run_code_unsafe`) is not offered, since that process is outside the sandbox. When Yew Harness runs from its source folder, that folder cannot be written in the sandbox; to change Yew Harness with Yew Harness, run the version installed from npm.

If the sandbox cannot start, Yew Harness runs without it and says why in the output of `yew serve` and under Startup in the settings: a program it needs is missing (ripgrep on macOS; bubblewrap, socat and ripgrep on Linux), the system does not let bubblewrap create user namespaces (the default from Ubuntu 24.04; sandbox-runtime's documentation says how to allow it), or `yew serve` was started with `YEW_SANDBOX=off`. Then commands run as your user account inside the outer guard described above: they can do what you can do in a terminal except what the guard closes, and that includes reading the API keys Yew Harness keeps in the keychain. If the guard cannot start either, they can also change Yew Harness's own records (decisions and permissions among them). The Linux sandbox has passed the everyday tests in a Debian 12 container and has not been tested on a real machine yet.

Letters from other sessions, web pages, mail and what MCP servers return are only data to Yew Harness and cannot approve anything for you. For a session that handles such outside content, use the default mode rather than skip: skip mode asks about nothing, a command outside the sandbox, publishing and a command on another machine included, so instructions hidden in that content could run outside the sandbox or send something out in your name.

## 中文

会话的命令和你自己加的 MCP 服务器在系统沙箱里运行。沙箱用的是 Anthropic 开源的 [sandbox-runtime](https://github.com/anthropics/sandbox-runtime)（Apache-2.0），macOS 上底层是系统的 Seatbelt，Linux 上是 bubblewrap。在沙箱里：

- 读写不了 Yew Harness 的数据目录（里面有你的决定、登录令牌和日志）和 macOS 替 Mac 应用的窗口存的登录 Cookie、缓存，也读不到钥匙串里的条目；
- 只能写会话的工作区、该会话配置的「可读写附加目录」、临时文件夹和沙箱自己的缓存，写不了 `~/.zshrc`、`~/.gitconfig` 这类文件，也写不了各仓库的钩子和配置；
- 改不了 Yew Harness 的程序和开机启动项，连不上它的本机端口，也连不上别的本机端口和局域网；
- 联网只放行常用的包管理源、GitHub、Gitee、配了密钥的模型服务商，以及你在「启动 → 沙箱全局放行域名」和该会话设置里放行的域名；连别的网站时先问你（能确定发起方时可选对本会话「总是允许」）；
- 读不到 `~/.ssh`、`~/.aws`、`~/.netrc` 这类凭据文件，也用不了 ssh-agent，除非你在设置的「启动」里打开；
- 读不到你在「默认设置 → 会话读不到的目录」里列的文件夹，会话的文件工具和沙箱外的命令也读不到；
- Linux 上连不上本机的 Unix 套接字，包括 D-Bus 会话总线。

Linux 上，命令运行中新建的仓库在命令结束前不受保护；命令结束后 Yew Harness 把新出现的钩子挪开，不让 git 执行，并在命令的输出里写明。

要在沙箱外跑的命令（比如要用钥匙串里凭据的 `git push`、要监听本机端口的开发服务器、Xcode 构建）是一项授权：默认方式下每次都先问你，自动方式下先由检查模型判断，跳过方式下不问，在记录里标出来；在外面跑的 git 不执行仓库里的钩子。在沙箱外跑的命令仍有一层外层保护，免得会话借它替你批掉审批：读写不了 Yew Harness 的数据目录、Mac 应用存登录状态的地方和你不让会话读的目录，拉不起保护之外的程序（`open`、`osascript` 叫别的程序），写不了之后会自己运行的启动文件、git 和 ssh 的设置、仓库的钩子和设置，别的都不拦。其中两类单用途操作——初始化/克隆/修改本地仓库配置（`git init`、`git clone`、`git remote add`、`git config --local`，在工作目录里跑，或用一个 `git -C` 加会话可写目录的完整路径）和拉起本机桌面应用（`open -a`）——默认和自动方式下每次都问你（不能设成总是允许，自动方式也不交给检查），跳过方式下不问：只有单条静态命令，外层保护才针对它临时放开对应单项（前者仅放开会话可写目录里仓库的 `.git/config`，强制 `GIT_TEMPLATE_DIR=""` 并在命令结束后审计 `.git/config` 中的可执行钩子/过滤器配置；后者仅放开 `lsopen`，所有文件写锁与 `appleevent-send` 仍保持封禁）；复合命令、动态命令和 `git config --global` 一律不放开外层保护。要在浏览器里打开网址，会话用 `open_url` 工具。这层保护不拦钥匙串和系统的服务管理，所以 Yew Harness 自己的命令行（管你的密钥和后台服务）和别的授权一样：默认和自动方式下问你，跳过方式下不问。这层保护起不来时，在沙箱外运行、命令里点名 Yew Harness 的数据或你不让会话读的目录、用 Yew Harness 的命令行，三种方式下都问你，跳过方式也一样。自带的浏览器和电脑操控不进沙箱：浏览器读写文件只在它自己的空文件夹里，打不开 `file://` 网页，也不碰 Yew Harness 自己的地址：调用里带这个地址的不执行，用你自己的 Chrome 时，共享的标签页里有开着 Yew Harness 的，浏览器工具一律不执行。会在浏览器服务自己的进程里跑代码的那个工具（`browser_run_code_unsafe`）不提供，因为这个进程不在沙箱里。从源码目录运行 Yew Harness 时，这个目录在沙箱里写不了，要用 Yew Harness 改 Yew Harness，请运行 npm 安装的版本。

沙箱起不来时，Yew Harness 不进沙箱照常运行，并在 `yew serve` 的输出和设置的「启动」里写明原因：缺少要用的程序（macOS 要 ripgrep，Linux 要 bubblewrap、socat 和 ripgrep），系统不让 bubblewrap 建用户命名空间（比如 Ubuntu 24.04 起的默认设置，放开的办法见 sandbox-runtime 的说明），或起 `yew serve` 时设了 `YEW_SANDBOX=off`。这时命令以你的系统账户、在上面说的外层保护里运行：除了保护拦住的，能做你在终端里能做的事，包括读 Yew Harness 存在钥匙串里的 API Key。外层保护也起不来时，还能改 Yew Harness 自己的记录（决定和授权也在里面）。Linux 上的沙箱在 Debian 12 的容器里跑过日常的测试，还没在实机上测过。

别的会话的信、网页、邮件和 MCP 返回的内容，Yew Harness 只当作数据，不能替你授权。会话要处理这类外来内容时，建议给它用默认方式，不用跳过：跳过方式下什么都不问，沙箱外的命令、对外发布和远程主机上的命令也不问，这类内容里藏的指令就可能在沙箱外执行，或以你的名义发出去。
