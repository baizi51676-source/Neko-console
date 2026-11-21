# 第三方声明 / Third-party notices

Aneko 采用 **AGPL-3.0-or-later**，见 [LICENSE](LICENSE)。
该许可证在 AGPL 全文之前附有一段额外许可（AGPL 第 7 节允许），用于豁免两个指定的
MIT 组件——详见下文「指定 MIT 组件的打包例外」。

本文件说明 Aneko 自身代码与第三方依赖、以及早期来源之间的关系。

## Aneko 的许可

Aneko 的界面层（布局、组件、样式令牌、主题引擎、动效系统）为独立实现，
整体以 **GNU Affero General Public License v3.0 or later** 发布。

这意味着：你可以自由使用、修改、分发 Aneko，但如果把它作为网络服务提供给他人使用，
**必须向这些用户提供完整的对应源码**（AGPL 第 13 条）。AGPL 并不禁止商业使用。

## 指定 MIT 组件的打包例外

下列两个组件由 Aneko 的同一版权持有人以 MIT 许可发布。AGPL 第 7 节允许在原许可证上
附加额外许可，因此 LICENSE 中已明确授权：可以将它们与 Aneko **打包、捆绑、嵌入、
链接或一并分发**（源码或二进制，含同一压缩包、容器镜像、安装包等），而**不会**因此
使这些组件本身受 AGPL 约束。

| 组件 | 版权 | 许可 |
|---|---|---|
| [astrbot_plugin_chat_history_archiver](https://github.com/baizi51676-source/astrbot_plugin_chat_history_archiver) | Copyright (c) 2026 baizi51676-source | MIT |
| [astrbot_plugin_multimodal_enhance](https://github.com/baizi51676-source/astrbot_plugin_multimodal_enhance) | Copyright (c) 2026 Skylar | MIT |

要点：

- 这两个组件**仍然只受各自的 MIT 许可约束**，额外许可不会改变、限制或扩张你依 MIT
  获得的任何权利。
- 再分发时，各组件自带的 MIT 许可文本**必须随附**（这是 MIT 自身的条件）。
- 例外**仅限**上述两个组件及其官方发布版本。它不覆盖 Aneko 自身、不覆盖他人修改过的
  版本，也不覆盖下文列出的其他依赖。

## 运行时依赖（均为宽松许可）

| 组件 | 许可 |
|---|---|
| React / React DOM | MIT |
| Vite / @vitejs/plugin-react | MIT |
| Tailwind CSS / @tailwindcss/vite | MIT |
| clsx | MIT |
| tailwind-merge | MIT |
| lucide-react（图标） | ISC |
| motion（动画） | MIT |
| TypeScript | Apache-2.0 |

各组件的版权归其作者所有，完整许可文本随 npm 包分发（`node_modules/<pkg>/LICENSE`）。

这些依赖以 MIT / ISC / Apache-2.0 授权，与 AGPL-3.0 兼容：将宽松许可的库纳入 AGPL 项目
是允许的，AGPL 的义务只针对 Aneko 自身的代码，不会改变这些依赖的许可。

> 注意：上表的宽松许可依赖本就与 AGPL 兼容，**无需**额外例外。上面那段打包例外
> 专门解决的是「把整个独立程序与 Aneko 一同分发」这一更进一步的场景。

## 早期来源说明

Aneko 早期曾以 `neko_console` 为名发布，该仓库由同一作者（Skylar）以 MIT 许可公开，
其界面基底又曾参考 SnowLuma 的界面源码（SnowLuma Source-Available Non-Commercial
License）。当前版本已完全重写：不再包含 SnowLuma 的任何代码或样式副本，
也不再包含 AstrBot 相关的业务代码、接口定义或配置映射表。

`neko_console` 的既有 MIT 授权对已获取该版本的人**永久有效**，Aneko 的 AGPL 许可
只约束本仓库及其后续版本。

## 第三方名称

本项目中出现的任何第三方产品名称与标识均归其所有者所有，仅作描述性使用，
不暗示任何官方身份或背书关系。
