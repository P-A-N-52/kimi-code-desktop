# 上游补丁登记表

对 `runtime/kimi-code` 内上游源码文件的任何修改都必须：
1. 直接提交源码修改（workspace 内文件不适用 `pnpm patchedDependencies`，该机制仅用于 registry 安装的外部依赖）；受控集成文件（`flake.nix`、根 `vitest.config.ts`、workspace lockfile 等）同样允许直接提交；
2. 在下表登记；
3. 能贡献上游的优先开上游 PR，同步时移除本地补丁。

活跃补丁数量是健康指标：**超过 5 个时暂停新增**，先评估是否该推动上游开放扩展点（见 `docs/plans/2026-08-07-source-backend-maintenance.md` §3）。

## 活跃补丁

| id | 文件 | 原因 | 上游 issue/PR | 移除条件 |
| --- | --- | --- | --- | --- |
| —（暂无） | | | | |

## 已移除补丁

| id | 文件 | 移除原因 | 移除于同步 |
| --- | --- | --- | --- |
| —（暂无） | | | |
