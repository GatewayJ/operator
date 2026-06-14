<!--
Copyright 2025 RustFS Team

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# RustFS Operator 故障注入测试方案

本文档描述如何在 RustFS Operator 当前 e2e 框架中落地一套可执行、可诊断、可逐步增强的故障注入测试体系。

核心原则：

- **Operator 负责测试环境编排**：创建 Tenant、准备本地 PV、暴露 RustFS S3 服务、等待状态、收集诊断现场。
- **故障注入器负责制造故障**：优先使用 Kubernetes-native 的 Chaos Mesh。
- **S3 workload 负责产生真实对象访问流量**：持续执行 `PUT`、`GET`、`HEAD`、`LIST` 等操作。
- **Jepsen-like checker 负责判断正确性**：它不制造故障，只基于操作历史和最终读取结果判断 RustFS 是否丢数据、读错数据或返回假成功。

也就是说，这套测试不是单纯验证 Operator 是否能拉起 StatefulSet，而是通过 Operator 部署出来的 RustFS 集群来验证 RustFS 在故障下的数据正确性。

## 目标

故障注入测试需要回答这些问题：

1. RustFS 在 Pod、节点、网络、磁盘 I/O 故障下，已经成功写入的数据是否仍然存在。
2. RustFS 是否会在磁盘损坏或网络分区后，把错误对象内容以 `200 OK` 返回给客户端。
3. RustFS 在请求超时、连接中断、部分失败后，是否存在“客户端认为失败但服务端实际写入”的未知状态。
4. Operator 是否能在故障期间正确观测 Tenant 状态，并在故障解除后回到 Ready。
5. 当测试失败时，e2e harness 是否能留下足够的日志、事件、历史记录和 checker 报告用于定位。

最重要的判定不是“故障期间所有请求都成功”，而是：

```text
可以失败，但不能假成功。
可以超时，但不能返回错误数据。
故障恢复后，已经确认成功的数据必须一致。
```

## 非目标

第一阶段不做这些事：

- 不替代 RustFS 自身的单元测试、集成测试或存储引擎内部测试。
- 不直接引入完整 Clojure Jepsen 测试套件。
- 不在普通开发集群上运行 destructive 测试。
- 不把性能压测结果当成 correctness 结论。
- 不在第一版验证所有 S3 线性一致性细节。
- 不默认测试多 Tenant、跨集群、真实块设备故障。

## 关于执行入口与依赖集群（关键答疑）

`make e2e-live-faults` 的定位是：

- 运行 `e2e/tests/faults.rs` 中的破坏性/故障注入测试。
- 通过 `RUSTFS_E2E_LIVE=1` + `RUSTFS_E2E_DESTRUCTIVE=1` 启动。
- 当前实现默认**依赖专用 Kind 环境**，因为 live 测试有 context 安全保护：
  - `E2eConfig` 默认 context 为 `kind-rustfs-e2e`。
  - `live::ensure_dedicated_context` 强制校验当前 kube context 等于该值。
  - `RUSTFS_E2E_CONTEXT` 之类的自定义 context 并未生效。

所以结论是：

- **按当前仓库实现，`make e2e-live-faults` 默认是在 Kind 上跑的，不是通用 K8S 默认入口。**
- 若要在真实 K8S 上跑，需要先做两类改造：
  1) 放开/扩展 context 注入能力（允许配置 context）。
  2) 增加真实集群友好型保护选项（例如 `RUSTFS_E2E_FAULT_ALLOW_NON_DEDICATED=1` 并要求人工确认）。

无论在哪个集群跑，建议再增加一层前置：

- Chaos Mesh 控制器与 `iochaos/podchaos/networkchaos` CRD 已安装。
- 目标 namespace / tenant selector 可见且可回收。

第一阶段的目标是补齐当前最大缺口：**真实故障注入 + 对象内容正确性检查**。

### 1) 简单开放真实 K8S 的最小可行方案

目标是：手工搭建真实 K8s 后，手动切换到该 context 就能执行，且保留安全门槛。

建议的最小改造（不改变现有 Kind 流程）：

- 让 `E2eConfig::from_env` 读 `RUSTFS_E2E_CONTEXT`（当前上下文白名单之外的新上下文）。
- 新增 `RUSTFS_E2E_ALLOW_REAL_CLUSTER=1`：启用非 `kind-rustfs-e2e` 的 context。
- 新增 `RUSTFS_E2E_REAL_CLUSTER_CONFIRM=1`：二次确认，避免误操作。
- 如果开启真实集群模式，`live::ensure_dedicated_context` 仍然返回明确提示，并要求上述两个开关同时为 1。

建议执行方式（真实集群模式）：

```bash
kubectl config use-context prod-e2e

RUSTFS_E2E_LIVE=1 \
RUSTFS_E2E_DESTRUCTIVE=1 \
RUSTFS_E2E_CONTEXT=prod-e2e \
RUSTFS_E2E_ALLOW_REAL_CLUSTER=1 \
RUSTFS_E2E_REAL_CLUSTER_CONFIRM=1 \
RUSTFS_E2E_FAULT_SCENARIO=io-eio \
cargo test --manifest-path e2e/Cargo.toml --test faults -- --ignored --nocapture
```

安全前提（必须明确）：

- 使用独立测试 namespace（避免和生产共享）。
- 目标 tenant/namespace 可清理，并有 `tenant selector` 或独立 label。
- Chaos 资源必须配置 label（如 `rustfs-e2e/run-id=<id>`）并按 label 清理。

### 2) Chaos 有 UI 吗？测试用例进度/结果能否在 UI 看到？

结论：

- Chaos Mesh 本体可选 UI（Chaos Dashboard），可直观看到 Chaos 实例生命周期。
- 本方案当前 e2e 用例的核心结果仍在**本地 artifacts 文件**（不是 UI）里：
  - `history.jsonl`
  - `checker-report.json`
  - `chaos-describe.txt`
  - `rustfs-pods-current.log`

建议运行期同时看两类视图：

1. Chaos 资源状态：`kubectl -n <chaos-ns> get iochaos,podchaos,networkchaos` 或 Dashboard。
2. e2e 结果：`target/e2e/artifacts/<case>/` 下的报告文件。

### 3) 用例失败后是否停止？最佳实践建议

推荐以“hard fail/soft fail”区分（文档已有）并落到 runner：

- hard fail（例如 committed 写入丢失、hash mismatch、无法恢复 tenant ready、清理失败）：
  - **停止后续用例**，先保留完整现场。
- soft fail（例如窗口超时、短暂列表缺失、unknown write 结果差异）：
  - 记录为 `WARN`，**允许继续**，便于收集同一轮更多信号。

这样做的最佳实践价值在于：

- 遇到明确数据正确性问题能第一时间阻断污染。
- 遇到临时性噪声不会浪费整个测试机会，方便一次性拿到更多故障序列证据。

## 当前 e2e 可复用基础

当前项目已经有适合故障测试的骨架，不需要另起一套测试系统。

已有能力：

| 能力 | 当前位置 | 用途 |
| --- | --- | --- |
| destructive 入口 | `make e2e-live-faults` | 专门运行破坏性故障测试。 |
| fault suite 占位 | `e2e/tests/faults.rs` | 后续真实故障测试入口。 |
| live/destructive/context guard | `e2e/src/framework/live.rs` | 防止误跑到非专用集群。 |
| local PV 准备 | `e2e/src/framework/storage.rs` | 为 RustFS Tenant 准备本地卷。 |
| Tenant/Secret 创建 | `e2e/src/framework/resources.rs` | 创建 e2e namespace、凭据和 Tenant。 |
| S3 port-forward | `e2e/src/framework/port_forward.rs` | 将 Tenant S3 服务暴露到本地。 |
| artifact collector | `e2e/src/framework/artifacts.rs` | 测试失败后收集 Kubernetes 现场。 |

关键约定：

- RustFS Pod selector 可使用 `rustfs.tenant=<tenant-name>`。
- RustFS 容器名是 `rustfs`。
- RustFS 数据卷路径遵循 `/data/rustfs0`、`/data/rustfs1`。
- Kind worker 将宿主机 `/tmp/rustfs-e2e-storage-*` 挂载到 worker 内部 `/mnt/data`。
- local PV 最终落在 worker 内部 `/mnt/data/volN`。

因此推荐方案是：

```text
复用当前 e2e harness
  + 新增 Chaos Mesh 故障注入模块
  + 新增 S3 workload
  + 新增 operation history
  + 新增对象存储 checker
```

## 总体架构

```text
e2e/tests/faults.rs
  |
  +-- 环境保护：live / destructive / dedicated Kind context
  +-- 环境准备：local PV / Tenant / Secret / Ready 等待
  +-- S3 workload：持续读写对象
  +-- history recorder：记录每次操作的开始、结束、结果、hash
  +-- nemesis：通过 Chaos Mesh 注入故障
  +-- checker：基于 history 和最终读回结果判断正确性
  +-- artifact collector：失败时收集诊断现场
```

建议新增模块：

```text
e2e/src/framework/chaos_mesh.rs
e2e/src/framework/fault_scenarios.rs
e2e/src/framework/s3_workload.rs
e2e/src/framework/history.rs
e2e/src/framework/checker.rs
```

模块职责：

| 模块 | 职责 |
| --- | --- |
| `chaos_mesh` | 生成、apply、describe、delete Chaos Mesh 资源。 |
| `fault_scenarios` | 定义故障场景名称、默认参数、目标对象和执行顺序。 |
| `s3_workload` | 对 RustFS Tenant S3 endpoint 执行对象读写流量。 |
| `history` | 将每个 S3 操作记录成 JSON Lines。 |
| `checker` | 基于 history 和最终读回结果验证对象存储不变量。 |
| `faults.rs` | 编排完整测试流程，不承载底层实现细节。 |

## 为什么优先用 Chaos Mesh

当前场景是在 Kubernetes 中通过 Operator 部署 RustFS，因此故障注入也应该尽量 Kubernetes-native。

Chaos Mesh 适合第一阶段，原因：

- 可以通过 namespace 和 label 精准选择 RustFS Pod。
- 可以指定容器名，避免影响非目标 sidecar 或其他组件。
- 支持 `PodChaos`、`NetworkChaos`、`IOChaos`。
- `IOChaos` 能对指定挂载路径返回 `EIO`，适合模拟磁盘坏块或磁盘 I/O 错误。
- `IOChaos mistake` 能模拟读写返回错误字节，适合模拟 bit rot / 静默损坏。
- 以 CRD 形式管理故障，方便 e2e harness apply/delete/describe/collect。

第一阶段建议只要求：

```text
Chaos Mesh 已安装
iochaos.chaos-mesh.org CRD 存在
podchaos.chaos-mesh.org CRD 存在
networkchaos.chaos-mesh.org CRD 存在
```

如果 CRD 不存在，测试应明确失败并给出提示，而不是静默跳过。

## 为什么不是直接上完整 Jepsen

完整 Jepsen 很强，但第一阶段不建议直接引入，原因：

- 当前项目 e2e 是 Rust-native，直接接入 Clojure Jepsen 成本高。
- 当前最大的缺口是“没有真实故障注入”和“没有对象内容正确性 checker”。
- 对象存储第一阶段最关键的不变量可以用更轻量的 checker 覆盖。
- 先把 `PUT/GET/hash` 这条基本正确性链路跑通，收益更高。

因此建议路线是：

```text
先做 Jepsen-like checker
后续再逐步增强为更完整的并发历史模型
```

Jepsen-like 的含义是：

- 有 workload。
- 有 nemesis。
- 有 operation history。
- 有明确 correctness model。
- 有自动 checker。

它不是简单 chaos smoke test。

## 安全模型

故障测试必须默认安全，不能误伤开发者当前 kube context。

必须保留并强化这些保护：

1. 必须设置 `RUSTFS_E2E_LIVE=1`。
2. 必须设置 `RUSTFS_E2E_DESTRUCTIVE=1`。
3. 当前 kube context 必须是专用 Kind：`kind-rustfs-e2e`。
4. 目标 namespace 必须来自 e2e 配置，例如 `rustfs-e2e-smoke`。
5. 所有故障资源必须带唯一 run id label。
6. 每个 Chaos 资源必须有 RAII-style cleanup guard。
7. 正常结束和异常失败都必须 best-effort 删除故障资源。
8. 默认故障持续时间要短，默认故障比例要小。
9. 测试失败时必须先收集 artifacts，再清理会影响诊断的信息。
10. destructive 场景保持 `#[ignore]`，只能通过显式 Make 目标执行。

建议增加环境变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RUSTFS_E2E_FAULT_SCENARIO` | `io-eio` | 选择故障场景。 |
| `RUSTFS_E2E_FAULT_DURATION_SECONDS` | `60` | 故障持续时间。 |
| `RUSTFS_E2E_FAULT_PERCENT` | `20` | 支持百分比注入的场景使用。 |
| `RUSTFS_E2E_WORKLOAD_OBJECTS` | `200` | 写入或校验对象数量。 |
| `RUSTFS_E2E_WORKLOAD_CONCURRENCY` | `8` | S3 并发度。 |
| `RUSTFS_E2E_CHAOS_NAMESPACE` | `chaos-mesh` | Chaos Mesh 资源所在 namespace。 |

## 操作历史模型

每个客户端可见的 S3 操作都应记录一条 JSON Lines。

示例：

```json
{
  "id": "op-000001",
  "scenario": "io-eio",
  "kind": "put",
  "bucket": "rustfs-fault-e2e",
  "key": "fault-e2e/run-123/object-1",
  "value_sha256": "abc123",
  "size_bytes": 1048576,
  "started_at_ms": 1710000000000,
  "ended_at_ms": 1710000001234,
  "outcome": "ok",
  "http_status": 200,
  "error": null
}
```

`outcome` 建议只保留四类，语义必须清晰：

| outcome | 含义 | checker 处理 |
| --- | --- | --- |
| `ok` | 客户端收到明确成功响应。 | 作为强正确性输入。 |
| `failed` | 客户端收到明确失败响应。 | 不要求最终存在。 |
| `timeout` | 客户端超时，不知道服务端是否完成。 | 作为 unknown 处理。 |
| `unknown` | 连接中断、body 未读完、port-forward 中断等。 | 作为 unknown 处理。 |

第一版 checker 只对 `ok` 的 `PUT` 做强校验。

对于 `timeout` 和 `unknown` 的写入：

- 最终存在可以接受。
- 最终不存在也可以接受。
- 需要在 report 中单独列出，方便后续分析。

这样可以避免把网络中断导致的“未知成功”误判为 RustFS 数据错误。

## Checker 不变量

### 不变量 1：成功写入的数据不能丢

如果客户端收到了成功写入：

```text
PUT key value_hash=H -> ok
```

故障解除并等待 Tenant 恢复后，必须满足：

```text
GET key -> 200
sha256(body) == H
```

否则 hard fail。

### 不变量 2：成功读取不能返回错误内容

任何一次 `GET` 只要返回 `200 OK`，并且该 key 有已知成功写入值，则：

```text
sha256(body) == expected_hash
```

如果 `GET` 返回 `200` 但 hash 不一致，这是最高优先级失败。

这比“请求是否成功”更重要，因为对象存储最危险的问题不是失败，而是**成功返回错误数据**。

### 不变量 3：明确失败的写入不要求存在

如果 `PUT` 返回明确失败：

```text
PUT key -> failed
```

那么最终这个 key 存在或不存在，都不作为第一版 hard fail。

### 不变量 4：未知结果单独记录

如果 `PUT` 是：

```text
timeout
unknown
```

则 checker 记录它最终是否 materialized，但不作为第一版 hard fail。

### 不变量 5：恢复后的 LIST 先作为 warning

故障解除并等待 Tenant Ready 后：

```text
LIST prefix
```

理论上应包含所有成功 `PUT` 且未成功 `DELETE` 的 key。

第一版可以将 LIST 缺失作为 warning，而不是 hard fail。等 RustFS 对 LIST 一致性的目标语义确认后，再升级为 hard fail。

## S3 workload 设计

第一阶段建议使用 Rust 代码实现 S3 workload，而不是依赖外部 `aws` 或 `mc` CLI。

原因：

- 操作历史更容易结构化记录。
- 请求 timeout、transport error、body error 更容易准确分类。
- 对象 hash 和操作结果可以在同一进程中关联。
- CI 和本地依赖更少。
- 后续可以扩展为并发 workload 和 checker replay。

建议在 `e2e/Cargo.toml` 后续增加：

```text
aws-sdk-s3
aws-config
aws-credential-types
sha2
rand
hex
```

第一版 workload 操作：

```text
CreateBucket
PutObject
GetObject
HeadObject
ListObjectsV2
DeleteObject
```

第一版建议使用唯一 key，不要并发覆盖同一个 key。

key 格式：

```text
fault-e2e/<run-id>/small/<uuid>
fault-e2e/<run-id>/medium/<uuid>
fault-e2e/<run-id>/large/<uuid>
```

对象大小建议：

| 类型 | 大小 |
| --- | --- |
| small | 4 KiB |
| medium | 64 KiB |
| large | 1 MiB |
| xlarge | 8 MiB |

第一版不建议默认使用太大对象，避免 e2e 运行过慢。

## 初始故障场景优先级

| 优先级 | 场景 | 后端 | 目的 |
| --- | --- | --- | --- |
| P0 | `io-eio` | Chaos Mesh `IOChaos` | 模拟单个 RustFS 数据卷读写返回 `EIO`。 |
| P0 | `pod-kill-one` | Chaos Mesh `PodChaos` | 模拟一个 RustFS Pod 死亡和 StatefulSet 恢复。 |
| P0 | `operator-restart` | Kubernetes delete/rollout | 验证控制面重启后状态恢复。 |
| P1 | `network-partition-one` | Chaos Mesh `NetworkChaos` | 模拟一个 RustFS Pod 与集群网络分区。 |
| P1 | `io-read-mistake` | Chaos Mesh `IOChaos` | 模拟读路径返回错误字节，即静默坏块。 |
| P1 | `disk-full` | local PV 填充或 IOChaos | 验证单盘空间耗尽行为。 |
| P2 | `direct-pv-corruption` | Kind worker 文件系统改写 | 模拟已经落盘的数据被破坏。 |
| P2 | `worker-restart` | Docker restart Kind worker | 模拟节点重启。 |
| P3 | `dm-flakey` | device mapper / loop device | 更接近真实块设备故障。 |
| P3 | `warp-under-chaos` | MinIO Warp + chaos | 故障期间性能退化分析。 |

## Chaos 工作流细化（参考 Litmus / Ceph / MinIO）

为了让故障测试每次都能复现、可解释、可连续运行，我们统一使用四段式流程（Litmus 类似 steady-state + inject + rollback）：

### 1）每个用例前置（Pre-flight）

- 检查上下文：`RUSTFS_E2E_LIVE=1`、`RUSTFS_E2E_DESTRUCTIVE=1`、专用 context、必需 CRD、`tenant ready`。
- 检查环境是否“干净”：上一次残留 chaos 标签清理、Tenant 不是未回收状态。
- 启动基线 workload，并记录 60 秒内基础成功率/时延（作为后续对比）。
- 预创建 bucket、预写入对象并打上 `committed` 标记，生成预期哈希清单。

### 2）故障注入阶段（Inject）

- 应用 chaos 资源后，等待 `applied` 且 `status` 进入 `Running`（有条件时等 10 秒以上）。
- 继续执行混合 S3 workload（`PUT/GET/HEAD/LIST`，包含小/中对象比例）。
- 对关键指标持续采样（P99、error_count、timeout_count、retry_count、retry_ratio）。
- 记录每次失败的分类（HTTP status、io 错误、超时、连接类错误、checksum mismatch）。

### 3）恢复阶段（Recover）

- 按计划移除 chaos 资源并等待回退完成。
- 触发一次控制面状态观察：Tenant 是否回到 Ready / Degraded 是否消失。
- 等待一次短暂稳态窗口（建议 60~120 秒）再进入最终校验。

### 4）结果评估与裁判（Judge）

- 严格失败（hard fail）：
  - 任何 `committed PUT` 在故障后恢复期无法成功 `GET` 校验通过；
  - `GET` 返回错误内容（hash 不一致）；
  - 故障对象 `LIST` 永久缺失（超出 timeout）；
  - Tenant 不在窗口内恢复；
  - chaos 资源残留。
- 可接受失败（deferred/soft fail）：
  - 故障窗口内短时超时、部分失败；
  - LIST 不完整；
  - `unknown write` 的最终存在与否差异。
- 结果落盘：
  - `history.jsonl`、`checker-report.json`、`chaos-manifest.yaml`、`chaos-describe.txt`、
  - 若是 hard fail 附加 `events.yaml`、`tenant-describe.txt` 与 `pods/containers log`。

### 5）“怎么进行下一个故障”

- `hard fail`：当前用例停止，收集完整 artifacts，不执行后续组合用例。
- `soft fail`：标记 `WARN` 后可继续，但应输出显式隔离策略（例如 `case-id` 前缀 + 单独目录）；
  若同类型连续 2 次 soft fail，则切换为 `ABORT` 并重置环境。
- `pass`：默认自动进入下一条用例；每 5 个用例做一次环境健康快检（context、Tenant ready、pod event 无异常波峰）。

## 用例组合策略（借鉴 Litmus 风格）

### 组合模式

1. `单故障序列`：按优先级 P0 → P1 → P2 顺序逐条执行，间隔固定恢复窗口。  
2. `逐步增强`：先单故障，再在基础流量下加入第二故障（如 node + net）。  
3. `并发故障`：高风险阶段，限定少量并发（如 `pod-kill-one + network-loss`）。  
4. `长稳混沌`：固定时长（300s）内按同一注入器重复波动，检查稳定性。

### 组合禁忌（避免误伤）

- 不要把 `disk-full` 与 `io-eio` 在同一轮直接并发。  
- 不要在 `crash/restart` 场景后立即进入 `network partition`，先确认恢复。  
- `direct-pv-corruption` 不参与并发组合，单独执行并且不和 P0 场景串联。  
- `operator-restart` 与 `tenant-scale` 等控制面类场景不与高强度 I/O 场景同轮执行。

## 30 个用例准备表（RustFS 节点 / 网络 / 磁盘）

| 分组 | ID | 场景名 | 说明 | 预期通过判定 |
| --- | --- | --- | --- | --- |
| 节点 | N1 | pod-kill-one | `PodChaos` 杀死一个 rustfs Pod，`action: pod-failure` | Tenant 最终 Ready；committed 对象可恢复读取 |
| 节点 | N2 | pod-evict-one | `PodChaos` 驱逐一个 Pod | 重建后服务可用，committed 可读 |
| 节点 | N3 | pod-restart-one | 发送 restart 信号 | 无永久不可用窗，恢复后 hash 不变 |
| 节点 | N4 | pod-kill-two | 同批次杀死两个 Pod | 服务降级可接受，最终可恢复 |
| 节点 | N5 | operator-restart | 重启 Operator Deployment | 控制面恢复后无需人工干预 |
| 节点 | N6 | tenant-rolling-restart | 重启 tenant 相关 Deployment/StatefulSet | 无对象损坏，连接最终稳定 |
| 节点 | N7 | rustfs-cpu-throttle | `StressChaos` 限制 CPU 资源 | 允许速率下降，不允许错误数据 |
| 节点 | N8 | rustfs-mem-throttle | `StressChaos` 限制 Memory 资源 | 允许 timeout，不允许 hash mismatch |
| 节点 | N9 | rustfs-io-saturation | `StressChaos` 压 IO（`size/cpu` 可替代） | 节点可恢复，committed 对象校验通过 |
| 节点 | N10 | worker-reboot | Kind worker 重启 | 恢复后对象一致性不回退 |
| 网络 | NW1 | network-partition-one | 单个 Pod 与集群网络分离 | 故障期可失败，恢复期无错误内容 |
| 网络 | NW2 | network-partition-two | 两个 Pod 分别隔离 | 同上 |
| 网络 | NW3 | network-latency | 加延迟（例如 200ms） | 允许重试增多，最终一致性正确 |
| 网络 | NW4 | network-loss | 丢包（1%~5%） | 允许超时，最终 GET 校验通过 |
| 网络 | NW5 | network-delay-variation | 延迟抖动 | 同上 |
| 网络 | NW6 | network-corrupt | 数据包损坏注入 | 不应返回错误内容 |
| 网络 | NW7 | network-duplication | 数据包重复 | 可失败重试成功，不产生静默错误 |
| 网络 | NW8 | network-bandwidth-limit | 带宽压缩 | 性能下降允许，正确性不降 |
| 网络 | NW9 | network-port-block | 阻断 9000/tcp（片段） | 允许连接失败，恢复后正常 |
| 网络 | NW10 | network-dns-flap | DNS 不稳定/短时失配 | 应不影响最终数据校验 |
| 磁盘 | D1 | io-eio-readwrite-low | `IOChaos fault`，低比例 | 触发错误码并验证可恢复 |
| 磁盘 | D2 | io-eio-readonly | 仅 READ 返回 EIO | 不返回错误对象，恢复后校验通过 |
| 磁盘 | D3 | io-eio-writeonly | 仅 WRITE 返回 EIO | 失败写请求可重试，已提交对象保持 |
| 磁盘 | D4 | io-read-mistake | `IOChaos mistake` 读错字节 | 不允许返回 200 with bad body |
| 磁盘 | D5 | io-write-mistake | 模拟误写入（实验性） | 建议观测为 non-hard fail，需人工确认 |
| 磁盘 | D6 | io-delay | 仅读延迟 | 允许 latency 上升 |
| 磁盘 | D7 | io-latency | 读写延迟 | 同上 |
| 磁盘 | D8 | io-fault-burst | 高比例突刺 EIO（例如 60% 短时） | 允许大面积失败但不得静默 corrupt |
| 磁盘 | D9 | disk-full | 容量填满到 90% | 新写失败可接受，已有对象可读 |
| 磁盘 | D10 | direct-pv-corruption | 直接改写 PV 文件 | P2 级别，允许单独执行与告警分析 |

### 执行矩阵与推荐顺序

- 第一轮：`N1, N2, N3, NW1, NW3, D1, D2`（重点验证主流程通道）
- 第二轮：`N4, N5, N6, NW2, NW4, NW8, D3, D6`
- 第三轮：`N7, N8, N9, NW5, NW6, NW7, D4`
- 第四轮：`NW9, NW10, D5, D7, D8, D9, D10`
- 第五轮：`N10 + NW1`（可作为组合演练）

## P0 场景：磁盘 EIO

这是建议最先实现的场景。

它能直接验证 RustFS 在磁盘读写失败下是否会丢失已提交对象，且非常适合当前 Kind local PV 结构。

目标：

```text
让某一个 RustFS Pod 的某一块数据卷，在部分 READ/WRITE 调用上返回 EIO。
```

Chaos Mesh `IOChaos` 示例：

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: rustfs-e2e-io-eio
  namespace: chaos-mesh
  labels:
    rustfs-e2e/run-id: "<run-id>"
spec:
  action: fault
  mode: one
  selector:
    namespaces:
      - rustfs-e2e-smoke
    labelSelectors:
      rustfs.tenant: e2e-tenant
  containerNames:
    - rustfs
  volumePath: /data/rustfs0
  path: /data/rustfs0/**/*
  methods:
    - READ
    - WRITE
  errno: 5
  percent: 20
  duration: "60s"
```

关键点：

- `volumePath` 是 RustFS 容器内挂载路径，不是宿主机 `/tmp/rustfs-e2e-storage-*`。
- `errno: 5` 对应 Linux `EIO`。
- `mode: one` 表示只选择一个匹配 Pod，避免第一版故障面过大。
- `percent: 20` 表示只影响部分 I/O 调用，避免全量不可用。

预期行为：

- 故障期间 S3 请求可以失败、超时或返回 5xx。
- RustFS 不能把错误数据作为成功响应返回。
- 已经成功 `PUT` 的对象，在故障解除后必须 hash 一致。
- Tenant 可以短暂 Degraded，但最终应回到 Ready。
- Chaos 资源必须被删除。

## P1 场景：静默坏块 / bit rot

EIO 是显式错误，比较容易处理；更危险的是静默损坏。

静默坏块的模拟方式：

```text
磁盘读操作看起来成功，但返回的字节是错的。
```

Chaos Mesh `IOChaos mistake` 示例：

```yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: rustfs-e2e-io-read-mistake
  namespace: chaos-mesh
spec:
  action: mistake
  mode: one
  selector:
    namespaces:
      - rustfs-e2e-smoke
    labelSelectors:
      rustfs.tenant: e2e-tenant
  containerNames:
    - rustfs
  volumePath: /data/rustfs0
  path: /data/rustfs0/**/*
  methods:
    - READ
  mistake:
    filling: random
    maxOccurrences: 1
    maxLength: 4096
  percent: 5
  duration: "60s"
```

预期行为：

- RustFS 可以返回错误。
- RustFS 可以从健康 shard 修复或读取。
- RustFS 不能返回 `200 OK` 且 body hash 错误。

这个场景是对象存储非常关键的测试，因为它验证的是“不要静默返回坏数据”。

## P2 场景：直接破坏 local PV 文件

当前 Kind worker 将宿主机目录挂载到 worker 内部：

```text
/tmp/rustfs-e2e-storage-1 -> /mnt/data
/tmp/rustfs-e2e-storage-2 -> /mnt/data
/tmp/rustfs-e2e-storage-3 -> /mnt/data
```

local PV 位于 worker 内部：

```text
/mnt/data/vol1
/mnt/data/vol2
...
```

后续可以通过直接改写某个 PV 文件模拟已经落盘的数据损坏：

```bash
docker exec rustfs-e2e-worker sh -c '
  f=$(find /mnt/data/vol1 -type f -size +4096c | head -n1)
  dd if=/dev/urandom of="$f" bs=4096 count=1 seek=1 conv=notrunc
'
```

这个场景比 `IOChaos mistake` 更接近真实“落盘数据已经损坏”，但也更危险：

- 可能破坏 RustFS 元数据。
- 可能导致恢复语义更复杂。
- 需要更明确的预期结果。
- 适合作为 P2，不适合作为第一版。

## 测试流程

第一版完整流程建议如下：

```text
1. 读取 E2eConfig
2. 检查 RUSTFS_E2E_LIVE=1
3. 检查 RUSTFS_E2E_DESTRUCTIVE=1
4. 检查 kube context == kind-rustfs-e2e
5. 检查 Chaos Mesh CRD 存在
6. 准备 local PV
7. 创建 e2e Tenant
8. 等待 Tenant Ready
9. 启动 Tenant S3 port-forward
10. 创建测试 bucket
11. 预写入一批对象，记录 key 和 sha256
12. 启动后台 verifier 持续读取已提交对象
13. apply Chaos Mesh 故障资源
14. 故障期间继续执行混合 S3 workload
15. delete Chaos Mesh 故障资源
16. 等待 Tenant 再次 Ready
17. 对所有成功 PUT 对象做最终 GET + sha256 校验
18. 生成 checker report
19. 成功则清理测试资源
20. 失败则收集 Kubernetes artifacts
```

伪代码：

```rust
#[tokio::test]
#[ignore = "destructive fault scenario; run through `make e2e-live-faults`"]
async fn fault_io_eio_preserves_committed_objects() -> Result<()> {
    let config = E2eConfig::from_env();

    live::require_live_enabled(&config)?;
    live::ensure_dedicated_context(&config)?;
    live::require_destructive_enabled(&config)?;
    chaos_mesh::require_iochaos_crd(&config)?;

    let result = async {
        storage::prepare_local_storage(&config)?;
        resources::apply_smoke_tenant_resources(&config)?;

        let client = kube_client::default_client().await?;
        let tenants = kube_client::tenant_api(client.clone(), &config.test_namespace);
        wait::wait_for_tenant_ready(tenants, &config.tenant_name, config.timeout).await?;

        let mut port_forward = PortForwardSpec::start_tenant_io(&config)?;
        let s3 = s3_workload::Client::from_tenant_port_forward(&config, &mut port_forward).await?;

        let mut history = history::Recorder::new("io-eio")?;
        s3.create_bucket().await?;
        s3.prefill_objects(&mut history).await?;

        let chaos = chaos_mesh::IoChaos::eio_on_rustfs_volume(
            &config,
            "/data/rustfs0",
            20,
            Duration::from_secs(60),
        );

        let guard = chaos.apply()?;
        s3.run_mixed_workload(&mut history).await?;
        drop(guard);

        wait::wait_for_tenant_ready(
            kube_client::tenant_api(client, &config.test_namespace),
            &config.tenant_name,
            config.timeout,
        )
        .await?;

        let report = checker::check_s3_history(&s3, &history).await?;
        report.require_success()?;

        Ok(())
    }
    .await;

    if result.is_err() {
        ArtifactCollector::new(&config.artifacts_dir)
            .collect_kubernetes_snapshot("fault_io_eio_preserves_committed_objects", &config)?;
    }

    result
}
```

## Chaos Mesh 模块设计

`chaos_mesh.rs` 建议提供这些能力：

```rust
pub fn require_iochaos_crd(config: &E2eConfig) -> Result<()>;
pub fn require_podchaos_crd(config: &E2eConfig) -> Result<()>;
pub fn require_networkchaos_crd(config: &E2eConfig) -> Result<()>;

pub struct ChaosGuard {
    name: String,
    namespace: String,
    kind: String,
}

impl Drop for ChaosGuard {
    fn drop(&mut self) {
        // best-effort kubectl delete
    }
}

pub struct IoChaosSpec {
    pub name: String,
    pub target_namespace: String,
    pub tenant_name: String,
    pub container_name: String,
    pub volume_path: String,
    pub methods: Vec<String>,
    pub action: IoChaosAction,
    pub percent: u8,
    pub duration: Duration,
}
```

实现要求：

- 所有 `kubectl` 命令必须通过现有 `framework::kubectl` 和 `framework::command` 边界。
- apply 前检查 CRD 是否存在。
- apply 后可以 `kubectl describe` 保存到 artifacts。
- 删除时必须 best-effort，不应 panic。
- 每个资源都带 `rustfs-e2e/run-id` label。
- 允许按 label 清理上一次异常残留。

## S3 workload 模块设计

`s3_workload.rs` 建议提供：

```rust
pub struct S3WorkloadClient {
    bucket: String,
    endpoint: String,
    timeout: Duration,
}

pub struct ObjectSpec {
    key: String,
    size_bytes: usize,
    sha256: String,
}

impl S3WorkloadClient {
    pub async fn create_bucket(&self) -> Result<()>;
    pub async fn put_object(&self, object: &ObjectSpec, history: &mut Recorder) -> Result<()>;
    pub async fn get_object(&self, key: &str, history: &mut Recorder) -> Result<Option<Vec<u8>>>;
    pub async fn head_object(&self, key: &str, history: &mut Recorder) -> Result<()>;
    pub async fn list_prefix(&self, prefix: &str, history: &mut Recorder) -> Result<Vec<String>>;
}
```

注意点：

- 每个请求必须有明确 timeout。
- 不要在 workload 层做无限 retry。
- 如果要 retry，必须记录每次尝试，而不是只记录最终结果。
- body 读取失败不能记为 `failed`，应记为 `unknown`。
- `PUT` 返回成功后才进入 committed set。

## Checker report 设计

最终 report 建议保存为 JSON：

```json
{
  "scenario": "io-eio",
  "run_id": "run-123",
  "committed_puts": 200,
  "missing_committed_objects": [],
  "hash_mismatches": [],
  "successful_corrupted_reads": [],
  "unknown_writes_materialized": [],
  "list_warnings": [],
  "tenant_recovered": true,
  "passed": true
}
```

hard fail 条件：

1. 成功 `PUT` 的对象最终 `GET` 不到。
2. 成功 `PUT` 的对象最终 `GET` hash 不一致。
3. 任意成功 `GET` 返回的 body hash 与预期不一致。
4. 故障解除后 Tenant 在 timeout 内没有回到 Ready。
5. Chaos 资源删除失败并仍然残留。
6. RustFS Pod 进入不可恢复 CrashLoopBackOff。

允许出现：

1. 故障期间 S3 请求失败。
2. 故障期间 S3 请求 timeout。
3. 故障期间 port-forward 连接中断。
4. Tenant 短暂 Degraded。
5. unknown write 最终存在或不存在。
6. 故障期间 LIST 不完整。

## artifacts 设计

每次 fault run 至少应该保存：

```text
history.jsonl
checker-report.json
chaos-manifest.yaml
chaos-describe.txt
events.yaml
pv-paths.txt
rustfs-pods-current.log
rustfs-pods-previous.log
tenant-describe.txt
pods-describe.txt
```

其中最关键的是：

- `history.jsonl`：复盘客户端看到的世界。
- `checker-report.json`：复盘 correctness verdict。
- `rustfs-pods-current.log`：定位 RustFS 如何处理故障。
- `events.yaml`：定位 Kubernetes 层是否出现调度、挂载、重启问题。
- `pv-paths.txt`：定位具体 PVC/PV/worker/hostPath 映射。

## Makefile 入口

保留现有总入口：

```bash
make e2e-live-faults
```

后续可以增加聚焦入口，方便本地调试：

```makefile
e2e-live-faults-io:
	RUSTFS_E2E_LIVE=1 RUSTFS_E2E_DESTRUCTIVE=1 RUSTFS_E2E_FAULT_SCENARIO=io-eio \
	cargo test --manifest-path $(E2E_MANIFEST) --test faults -- --ignored --nocapture

e2e-live-faults-pod:
	RUSTFS_E2E_LIVE=1 RUSTFS_E2E_DESTRUCTIVE=1 RUSTFS_E2E_FAULT_SCENARIO=pod-kill-one \
	cargo test --manifest-path $(E2E_MANIFEST) --test faults -- --ignored --nocapture
```

普通开发检查仍然使用：

```bash
make e2e-check
make pre-commit
```

不要把 destructive 场景混进普通 `make e2e-live-run`。

## 第一版最小可交付范围

建议第一版只交付一个真实场景：

```text
fault_io_eio_preserves_committed_objects
```

它应该包含：

1. live/destructive/context guard。
2. Chaos Mesh `IOChaos` CRD 检查。
3. Tenant 创建和 Ready 等待。
4. S3 bucket 创建。
5. S3 prefill 对象并记录 hash。
6. apply `IOChaos fault errno=5`。
7. 故障期间持续读写。
8. delete `IOChaos`。
9. Tenant 恢复 Ready 等待。
10. 所有成功 `PUT` 对象最终 `GET + sha256` 校验。
11. history 和 checker report 输出。
12. 失败时 artifacts 收集。

这个版本已经能证明系统从“占位骨架”升级为“真实故障注入 + 数据正确性校验”。

## 分阶段实施计划

### Phase 1：磁盘 EIO 基线

- 新增 `chaos_mesh`。
- 新增 `history`。
- 新增 `checker`。
- 新增 `s3_workload`。
- 实现 `io-eio`。
- 使用唯一对象 key。
- 默认小对象数、短持续时间、低故障比例。

验收：

- `make e2e-check` 通过。
- `make e2e-live-faults` 可在专用 Kind 集群运行 `io-eio`。
- 如果 committed object 丢失，测试失败。
- 如果 successful GET 返回错误字节，测试失败。

### Phase 2：进程和网络故障

- 新增 `pod-kill-one`。
- 新增 `network-partition-one`。
- 复用同一套 workload/history/checker。

验收：

- Pod 死亡后 StatefulSet 能恢复。
- 网络分区期间可以失败，但不能返回错误数据。
- 网络恢复后 committed object 可读回。

### Phase 3：静默损坏

- 新增 `io-read-mistake`。
- 新增 direct local-PV corruption。
- 强化 hash mismatch 和 repair behavior 报告。

验收：

- RustFS 对错误字节返回错误或修复。
- 不允许 `200 OK` 返回错误对象内容。

### Phase 4：长稳和性能

- 增加随机组合故障。
- 增加长时间 soak。
- 可选接入 MinIO Warp 或 COSBench。

注意：

- 性能结果和 correctness verdict 必须分离。
- 压测失败不等于数据错误。
- 数据错误永远是 hard fail。

### Phase 5：块设备级故障

- 研究 `dm-flakey`、`dm-error`、loop device-backed PV。
- 只在 Linux runner 或专用环境启用。
- 不进入默认本地 Kind 流程。

这个阶段更接近真实磁盘坏块，但环境成本明显更高。

## 与其他测试框架的关系

| 框架或工具 | 当前项目定位 |
| --- | --- |
| 当前 e2e harness | Operator 编排、Tenant 生命周期、artifacts 收集。 |
| Chaos Mesh | Kubernetes-native nemesis，负责制造故障。 |
| Jepsen-like checker | 判断对象存储 correctness，不制造故障。 |
| MinIO Mint | 后续用于 S3 API 兼容性，不作为故障 checker。 |
| MinIO Warp | 后续用于故障期间性能压测，不作为 correctness verdict。 |
| COSBench | 后续用于大规模对象存储压测。 |
| Ceph s3-tests | 后续用于 S3 行为兼容性参考。 |
| Ceph Teuthology | 借鉴大规模编排思想，当前不直接引入。 |
| Ozone fault injection | 借鉴 FUSE/agent 精细磁盘故障思想，作为后续增强。 |

当前最优组合：

```text
RustFS Operator e2e
  + Chaos Mesh
  + Rust-native S3 workload
  + Jepsen-like object checker
```

## 是否可开始编码

按当前文档状态，可以开始第一阶段编码，但建议先按“最小可交付”边界推进：先只支持 `io-eio` 与 `pod-kill-one`，其余场景先保留为待实现。

开工前必须满足以下硬条件：

- `chaos_mesh` 模块具备最小能力：`apply / wait / describe / delete / cleanup`；
- `s3_workload` 支持 `create bucket / put / get / head / list`，并有单次请求 timeout；
- `history` 可以记录 committed put、get 结果和失败分类；
- `checker` 能输出 hard fail 的明确 verdict；
- `artifacts` 至少包含 `chaos-manifest.yaml`、`history.jsonl`、`checker-report.json`；
- `faults.rs` 测试按 `live + destructive + context` guard 编排单场景跑通。

达到上述条件后，建议执行：

- `RUSTFS_E2E_LIVE=1 RUSTFS_E2E_DESTRUCTIVE=1 RUSTFS_E2E_FAULT_SCENARIO=io-eio cargo test ... --ignored`
- 通过后再加 `pod-kill-one`，接着再引入 `network-partition-one` 和 `disk-full`。

## Chaos 使用是否最佳实践

结论：思路是正确的、接近实操最佳实践，但要注意“工程化收敛”。

### 优势（已对齐）

- 与业务真实场景贴近：先 `create workload -> inject -> recover -> judge`，和 Litmus 的生命周期一致。
- 关键错误分类清晰：区分“故障窗口可接受失败”与“最终一致性失败”。
- 有回退闭环：在回滚后做健康等待，再做 committed 校验。
- 有可审计面：每次 run 都输出可复盘的 history/checker/chaos artifacts。

### 需要继续加固的边界

- `apply` 后要加状态等待：不是只看资源创建成功，而是等待 chaos 生效窗口。
- selector 要稳定：按 tenant label + namespace 限定，避免误伤其他 workload。
- 幂等与清理：支持 `label-selector` 级联清理，避免残留资源污染下一轮测试。
- 节流与配额：所有故障参数都要有上限（`duration/percent/retry/timeout`），避免把集群打到不可恢复状态。
- 失败分类标准：明确 `unknown` 的边界，避免把 transport 波动误判为数据损坏。
- 与控制面隔离：控制面重启类场景不与大规模 I/O 并发混合。

### 与可借鉴实践的差异与取舍

- 和 Litmus 相同：故障资源是 Kubernetes-native CR，测试通过独立场景 runbook 执行。
- 和 Jepsen 相同：强调最终结果（committed objects）而不是瞬时成功率。
- 与 ceph/minio 的可扩展压测不同：该方案先以 correctness 为主，不把性能当主指标。

建议将其理解为“当前可落地的工程最佳实践”，并在后续逐步补齐：  
1) 并发故障矩阵；2) 更完整的控制面回归；3) 真实块设备级注入；4) 压测指标与 correctness 分离的长期 soak。

## 实现注意事项

- 所有外部调用必须有 timeout。
- workload 不要无限 retry。
- retry 必须记录每次尝试。
- 不要把 transport unknown 错误归类为 definite failed。
- 不要把 performance degradation 误判为 correctness failure。
- 故障资源必须总是 best-effort cleanup。
- artifacts 中不要记录密钥明文。
- 第一版避免覆盖同一个 key，降低 checker 复杂度。
- 后续再逐步加入 same-key overwrite、delete、multipart、LIST consistency。

## 参考资料

- [Chaos Mesh IOChaos](https://chaos-mesh.org/docs/simulate-io-chaos-on-kubernetes/)
- [Chaos Mesh Documentation](https://chaos-mesh.org/docs/)
- [Jepsen](https://jepsen.io/)
- [MinIO Warp](https://docs.min.io/warp/)
- [COSBench](https://github.com/intel-cloud/cosbench)
- [Ceph s3-tests](https://github.com/ceph/s3-tests)
