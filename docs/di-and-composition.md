# 组合内核的注入理论

运行时怎么把插件拼起来，不靠「再写一个加载器」，靠两套已经验证过的理论：

1. **Spring IoC / DI**（装配、作用域、生命周期、层次容器）
2. **Cordis**（可逆注册、事件 waterfall、isolate 平面）

Cordis 解决「插件树怎么长、怎么卸」。Spring 解决「对象从哪来、活多久、依赖怎么声明才不会在运行时才炸」。两者叠在同一套 Context 上。

---

## 1. Spring 在讲什么

### 1.1 IoC：别来调用我，我会调用你

普通写法：`new BashTool(new LocalShell())`。工具自己决定用哪一个 Shell，换 Docker 就要改工具。

IoC：工具只声明「我需要一个 `ShellExecutor`」。容器在启动时把实现塞进来。这就是好莱坞原则（Don't call us, we'll call you）。

Harness 里同一句话：

```text
Consumer  不 import Provider
Provider  只 provide 到名字上（ctx.shell）
Definition 是双方唯一共同依赖的接口
```

这和 Spring 的「只依赖接口、配置决定实现」是同一条。

### 1.2 三种注入，我们只认一种当默认

| 方式 | Spring | 用在 harness | 决策 |
| --- | --- | --- | --- |
| **构造器注入** | 必选依赖；对象可 `final`；环在启动期暴露 | `inject = ['shell', 'tools']`，齐了才 `apply(ctx)` | **默认。缺依赖 = 启动失败** |
| Setter / 可选注入 | 可选协作对象 | `ObjectProvider` 式：`ctx.get('browser')` 可空 | 仅可选能力（browser、MCP） |
| 字段注入 | `@Autowired` 打在字段上 | 对等于插件里随手 `global.shell` | **禁止**。依赖从签名上看不出来 |

构造器注入的理论后果：插件的公开依赖必须写在 `inject` 里，和 Spring 构造器参数列表一样，是可审查的契约。

### 1.3 作用域：单例不是唯一真相

Spring 默认 **singleton**（一个容器里一个实例）。还有 prototype、request、session，以及自定义 scope。

映射到 harness：

| Spring | Harness |
| --- | --- |
| singleton | Host 平面：`ctx.llm`、`ctx.traj`、`ctx.policy`、官方 `agent-loop` |
| 自定义 `thread` scope | 每个 Agent Thread 一份：`ctx.shell`、MCP、会话 hook |
| prototype | 每次 `delegate` 子 Agent 新建 isolate 子容器 |
| 层次容器 parent/child | Host = **父 ApplicationContext**；Thread = **子容器** |

关键定理（Spring 层次容器原样成立）：

- 子能看见父的 bean（Thread 能调 `ctx.llm`、`ctx.traj`）
- 父看不见子（Host 不得去碰某个 Thread 的 persistent shell）
- 关子容器只卸子 bean，父还在
- 子里同名 bean **覆盖** 父（项目插件覆盖 bundled 工具）

Cordis 的 `isolate` 就是「给这个 Thread 开一个 child context」。有了 Spring 的层次模型，isolate 不再是一句注释，而是容器语义。

### 1.4 生命周期：new 出来不算就绪

Spring bean 不是构造完就能用。顺序是：

```text
实例化
  → 注入依赖
  → Aware（我是谁、我在哪个容器）
  → BeanPostProcessor.before
  → init（@PostConstruct / InitializingBean）
  → BeanPostProcessor.after   ← AOP 代理通常在这里包上
  → 就绪
  → destroy（@PreDestroy / DisposableBean）
```

映射：

| Spring | Harness |
| --- | --- |
| 实例化 + 注入 | Loader 按 `inject` 等待 → `apply(ctx)` |
| init | 插件 `start()`：连 MCP、开 persistent shell |
| BeanPostProcessor.after | 给 `ctx.shell.run` 包上审批 / 轨迹 / sandbox 代理 |
| destroy | `effect` 的 disposer：关子进程、撤 schema、撤 waterfall |

**可逆注册不是 Cordis 的发明，是 DI 容器的 destroy 回调。** Cordis `ctx.effect` 只是把「每个注册都必须带回滚」写成了 API。我们两条都要：生命周期钩子 + 每个 effect 可逆。

### 1.5 循环依赖：构造器环必须在启动期死掉

Spring 用三级缓存缓解 **setter** 环；**构造器环** 默认直接失败。原因：对象还没构造完，没法安全地把不完整实例注入别人。

Harness 默认构造器式 `inject`，因此：

- A inject B、B inject A → Loader.await() **失败并点名这两个 id**
- 禁止「先半初始化再回头填」的隐式环（那会让轨迹里出现半只工具）
- 可选依赖不得造成环：用 `getOptional('browser')`

半棵树能跑 Agent，等于 Spring 里 `allowCircularReferences=true` 还把构造器环放过去——评测和 replay 都会撒谎。

### 1.6 AOP：横切不要写进业务 bean

Spring 用代理把事务、安全、日志从业务方法里拿出去。Around advice 的 `proceed()` 就是 Cordis waterfall 的 `next()`。

```text
tools/pre-execute   ≈  MethodInterceptor.pre
tools/execute       ≈  proceed() → 真正的 ctx.shell.run
tools/post-execute  ≈  after / afterThrowing
```

审批、脱敏、截断、记轨迹，全部是 **针对 Definition 接口的代理**，不是在每个 tool 里复制粘贴。谁提供 `ctx.shell` 无所谓，代理打在接口上。这是 Spring「面向接口的 AOP」原句。

### 1.7 多实现：@Qualifier，不是 if

同一接口多个 Provider 时，Spring 用 `@Primary` / `@Qualifier` / 名字。

Harness：

- **独占服务**（`ctx.shell`）：同时 provide 两次 → 启动失败。Profile 决定是 local 还是 docker。
- **注册表服务**（`ctx.tools`）：多实现共存，按 name 进 Map。项目插件覆盖同名 tool。
- 名字进 plugin_lock，replay 才能知道当时用的是哪一个。

---

## 2. 叠到我们的内核上

```text
父容器 Host（Spring singleton + 官方 loop）
    │  子能看见：llm, traj, policy, workspace, agents
    │
    ├─ 子容器 Thread-A（isolate / thread scope）
    │     shell, mcp, 会话 hook, 项目 tool
    └─ 子容器 Thread-B
          另一只 shell，互不看见
```

装配规则（写进单测）：

1. 必选依赖只走 `inject`（构造器）。缺则不开工。
2. 可选依赖走 `getOptional`，禁止字段式偷拿。
3. Host bean 禁止 inject 任何 isolate 服务。
4. 子容器关闭 = 对其中每一个 effect 调 disposer，顺序与注册相反（Spring destroy 也是逆序）。
5. 给 `fs` / `subprocess` / `shell` / `tools` 在父容器里注册 Definition，Provider 可在父（local 单例 fs 策略）或子（persistent shell）。
6. AOP 代理在 init 之后套上；轨迹里记的是代理之后模型真正看见的结果。

---

## 3. 和 Cordis 一词对照

| Spring | Cordis | 我们 |
| --- | --- | --- |
| ApplicationContext | Context | 同左 |
| parent/child context | 子 Context + isolate | Host 父 / Thread 子 |
| `@Bean` / `provide` | `ctx.provide` | provide |
| 构造器参数 | `inject` | inject，启动期失败 |
| `@PreDestroy` | `ctx.effect` disposer | 必须可逆 |
| BeanPostProcessor / AOP | waterfall | `tools/*` `agent/*` |
| `@Profile` | profile yaml | `profiles/standard.yml` |
| singleton | Host 服务 | llm、traj、loop |
| 自定义 scope | isolate realm | Thread 子容器 |
| `@Qualifier` | 服务名 / 注册表 key | plugin_lock 中的 id |
| 构造器循环失败 | await 未激活 | Loader 点名失败 |

不引入 Spring 框架，不引入 Java。把 **理论收成容器不变量**，用 TypeScript 实现一个小容器即可。
