export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // v0.8.3：显式在运行时启动 initializeApp。
    // 以前只靠 root layout 里 `import "@/shared/services/bootstrap"` 的模块副作用触发，
    // 但 dashboard 的根布局在构建期就被预渲染成静态壳（含 layout 元数据 + Loading 占位），
    // 运行时该模块并不会被求值 —— 结果是 initializeApp 从不执行：看守/隧道自动恢复不跑，
    // Qoder 签到与 CodeBuddy 激励调度器都不启动（重启进程后功能静默消失）。
    // bootstrap 内部有 global.__appBootstrapped 单例守卫，重复引入无副作用。
    await import("@/shared/services/bootstrap");
  }
}
