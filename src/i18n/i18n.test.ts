import { describe, expect, test } from "bun:test";
import {
  createTranslator,
  DEFAULT_LOCALE,
  detectSystemLocales,
  interpolate,
  resolveSupportedLocale,
} from "./index";
import { en } from "./resources/en";
import { zhCN } from "./resources/zh-CN";

describe("i18n locale resolution", () => {
  test("defaults to English when no preference or system locale matches", () => {
    expect(resolveSupportedLocale(null, [])).toBe(DEFAULT_LOCALE);
    expect(resolveSupportedLocale(undefined, ["fr-FR", "de-DE"])).toBe("en");
  });

  test("resolves zh-CN for Chinese preference or system locale", () => {
    expect(resolveSupportedLocale("zh-CN", [])).toBe("zh-CN");
    expect(resolveSupportedLocale("zh", [])).toBe("zh-CN");
    expect(resolveSupportedLocale("zh-Hans-CN", [])).toBe("zh-CN");
    expect(resolveSupportedLocale(null, ["zh-CN", "en-US"])).toBe("zh-CN");
    expect(resolveSupportedLocale(null, ["zh-TW", "en-US"])).toBe("zh-CN");
    expect(resolveSupportedLocale(null, ["zh-Hans"])).toBe("zh-CN");
  });

  test("resolves en for English preference", () => {
    expect(resolveSupportedLocale("en-US", ["zh-CN"])).toBe("en");
    expect(resolveSupportedLocale("en", ["zh-CN"])).toBe("en");
  });

  test("detects system locales safely without crashing", () => {
    const detected = detectSystemLocales();
    expect(Array.isArray(detected)).toBe(true);
  });
});

describe("i18n string interpolation", () => {
  test("replaces {{variable}} placeholders with provided values", () => {
    expect(
      interpolate("Hello {{name}}, you have {{count}} messages", {
        name: "Alice",
        count: 5,
      }),
    ).toBe("Hello Alice, you have 5 messages");
  });

  test("leaves unprovided placeholders untouched", () => {
    expect(interpolate("Hello {{name}}", {})).toBe("Hello {{name}}");
  });

  test("handles empty or null values gracefully", () => {
    expect(interpolate("Template without vars")).toBe("Template without vars");
  });
});

describe("i18n translations and fallback", () => {
  const tEn = createTranslator("en");
  const tZh = createTranslator("zh-CN");

  test("provides English translation for known keys", () => {
    expect(tEn("diagnostics.statusHealthy")).toBe("Connected and ready");
    expect(tEn("navigation.tabs.account")).toBe("Account");
    expect(tEn("filters.kinds.pullRequest")).toBe("PRs");
    expect(tEn("resource.actions.createWorkspace")).toBe("Create workspace");
  });

  test("provides Chinese translation for known keys", () => {
    expect(tZh("diagnostics.statusHealthy")).toBe("连接正常，准备就绪");
    expect(tZh("navigation.tabs.account")).toBe("账户");
    expect(tZh("filters.kinds.pullRequest")).toBe("PR");
    expect(tZh("resource.actions.createWorkspace")).toBe("创建工作区");
  });

  test("supports interpolation in both languages", () => {
    expect(tEn("navigation.projectsBanner", { host: "Localhost" })).toBe(
      "Paseo projects on Localhost",
    );
    expect(tZh("navigation.projectsBanner", { host: "Localhost" })).toBe(
      "位于 Localhost 上的 Paseo 项目",
    );

    expect(
      tEn("resource.errors.unableToOpenExternal", {
        repository: "repo",
        number: 42,
      }),
    ).toBe("Unable to open repo#42 on GitHub.");
    expect(
      tZh("resource.errors.unableToOpenExternal", {
        repository: "repo",
        number: 42,
      }),
    ).toBe("无法在 GitHub 打开 repo#42。");
  });
  test("localizes sort labels and summary phrases with counts", () => {
    expect(tEn("sort.updated")).toBe("Updated");
    expect(tEn("sort.priority")).toBe("Priority");
    expect(tEn("sort.created")).toBe("Created");
    expect(tEn("sort.comments")).toBe("Comments");
    expect(tEn("sort.directionAsc")).toBe("Asc");
    expect(tEn("sort.directionDesc")).toBe("Desc");
    expect(tZh("sort.updated")).toBe("最近更新");
    expect(tZh("sort.priority")).toBe("优先级");
    expect(tZh("sort.created")).toBe("创建时间");
    expect(tZh("sort.comments")).toBe("评论数");
    expect(tZh("sort.directionAsc")).toBe("升序");
    expect(tZh("sort.directionDesc")).toBe("降序");
    expect(tEn("summary.total", { count: 4 })).toBe("4 total");
    expect(tZh("summary.total", { count: 4 })).toBe("共 4 项");
    expect(tEn("summary.needsAttention", { count: 2 })).toBe(
      "2 need attention",
    );
    expect(tZh("summary.needsAttention", { count: 2 })).toBe("2 项待处理");
  });
  test("localizes compact diagnostics recheck action", () => {
    expect(tEn("diagnostics.recheck")).toBe("Re-check");
    expect(tZh("diagnostics.recheck")).toBe("重新检测");
  });
  test("localizes direct workspace actions and outcomes", () => {
    expect(tEn("resource.actions.creatingWorkspace")).toBe(
      "Creating workspace…",
    );
    expect(tZh("resource.actions.creatingWorkspace")).toBe("正在创建工作区…");
    expect(tEn("resource.toasts.workspaceCreated")).toBe("Created workspace");
    expect(tZh("resource.toasts.workspaceOpened")).toBe("已打开工作区");
    expect(tEn("resource.errors.localProjectNotFound")).toBe(
      "No local project was found for this GitHub repository.",
    );
    expect(tZh("resource.errors.baseBranchUnavailable")).toBe(
      "本地项目没有可用的基础分支。",
    );
  });
  test("localizes active label and filter reset actions", () => {
    expect(tEn("filters.activeLabel", { label: "bug" })).toBe("Label: bug");
    expect(tZh("filters.activeLabel", { label: "bug" })).toBe("标签：bug");
    expect(tEn("filters.clearLabel")).toBe("Clear label");
    expect(tZh("filters.clearLabel")).toBe("清除标签");
    expect(tEn("filters.clearAll")).toBe("Clear filters");
    expect(tZh("filters.clearAll")).toBe("清除所有筛选");
    expect(tEn("filters.mineWithCount", { count: 3 })).toBe("Mine (3)");
    expect(tZh("filters.mineWithCount", { count: 3 })).toBe("我的 (3)");
    expect(tEn("filters.draftsWithCount", { count: 2 })).toBe("Drafts (2)");
    expect(tZh("filters.draftsWithCount", { count: 2 })).toBe("草稿 (2)");
    expect(tEn("filters.activeMilestone", { milestone: "v1.0.0" })).toBe(
      "Milestone: v1.0.0",
    );
    expect(tZh("filters.activeMilestone", { milestone: "v1.0.0" })).toBe(
      "里程碑：v1.0.0",
    );
    expect(tEn("filters.noMilestone")).toBe("No milestone");
    expect(tZh("filters.noMilestone")).toBe("未分配里程碑");
    expect(tEn("filters.clearMilestone")).toBe("Clear milestone");
    expect(tZh("filters.clearMilestone")).toBe("清除里程碑");
    expect(tEn("resource.badges.draft")).toBe("Draft");
    expect(tZh("resource.badges.draft")).toBe("草稿");
  });
  test("localizes compact diagnostics status", () => {
    expect(tEn("diagnostics.statusHealthy")).toBe("Connected and ready");
    expect(tZh("diagnostics.statusHealthy")).toBe("连接正常，准备就绪");
    expect(tEn("diagnostics.statusNotAuthenticated")).toBe(
      "GitHub CLI is not authenticated",
    );
    expect(tZh("diagnostics.statusNotAuthenticated")).toBe(
      "GitHub CLI 未认证登录",
    );
  });
  test("localizes PR checks breakdown details and conclusions", () => {
    expect(tEn("checksDetails.title")).toBe("Checks breakdown");
    expect(tZh("checksDetails.title")).toBe("Checks 明细");
    expect(tEn("checksDetails.showDetails", { count: 3 })).toBe(
      "View checks (3)",
    );
    expect(tZh("checksDetails.showDetails", { count: 3 })).toBe(
      "查看 Checks (3)",
    );
    expect(
      tEn("checksDetails.conclusion", {
        name: "test / unit",
        status: "failed",
      }),
    ).toBe("test / unit: failed");
    expect(
      tZh("checksDetails.conclusion", {
        name: "test / unit",
        status: "失败",
      }),
    ).toBe("test / unit: 失败");
  });
  test("localizes per-resource refresh actions and toasts", () => {
    expect(tEn("resource.actions.refreshItem")).toBe("Refresh item");
    expect(tEn("resource.actions.refreshingItem")).toBe("Refreshing…");
    expect(tZh("resource.actions.refreshItem")).toBe("刷新此项");
    expect(tZh("resource.actions.refreshingItem")).toBe("正在刷新…");
    expect(
      tEn("resource.toasts.refreshedItem", {
        repository: "getpaseo/paseo",
        number: 100,
      }),
    ).toBe("Refreshed getpaseo/paseo#100");
    expect(
      tZh("resource.toasts.refreshedItem", {
        repository: "getpaseo/paseo",
        number: 100,
      }),
    ).toBe("已刷新 getpaseo/paseo#100");
    expect(
      tEn("resource.toasts.refreshFailed", {
        repository: "getpaseo/paseo",
        number: 100,
      }),
    ).toBe("Failed to refresh getpaseo/paseo#100");
    expect(
      tZh("resource.toasts.refreshFailed", {
        repository: "getpaseo/paseo",
        number: 100,
      }),
    ).toBe("刷新 getpaseo/paseo#100 失败");
  });

  test("distinguishes unknown checks status and interpolates check counts", () => {
    expect(tEn("checksStatus.unknown")).toBe("unknown status");
    expect(tZh("checksStatus.unknown")).toBe("状态未知");
    expect(tEn("checksDetails.showDetails", { count: 1 })).toBe(
      "View checks (1)",
    );
    expect(tZh("checksDetails.showDetails", { count: 1 })).toBe(
      "查看 Checks (1)",
    );
  });

  test("localizes pending review and mergeability states", () => {
    expect(tEn("reasons.waitingForReview")).toBe("Waiting for review");
    expect(tZh("reasons.waitingForReview")).toBe("等待评审");
    expect(tEn("reasons.waitingForMergeability")).toBe(
      "Waiting for merge status",
    );
    expect(tZh("reasons.waitingForMergeability")).toBe("等待合并状态");
  });
  test("localizes cross-resource relationship references and focus actions", () => {
    expect(tEn("resource.meta.linkedReference", { number: 42 })).toBe(
      "Ref #42",
    );
    expect(tZh("resource.meta.linkedReference", { number: 42 })).toBe(
      "引用 #42",
    );
    expect(tEn("resource.relationships.linkedResource", { number: 42 })).toBe(
      "Linked #42",
    );
    expect(tZh("resource.relationships.linkedResource", { number: 42 })).toBe(
      "关联 #42",
    );
    expect(tEn("resource.relationships.focusResource", { number: 42 })).toBe(
      "Focus #42",
    );
    expect(tZh("resource.relationships.focusResource", { number: 42 })).toBe(
      "聚焦 #42",
    );
    expect(tEn("resource.relationships.clearFocus")).toBe("Clear focus");
    expect(tZh("resource.relationships.clearFocus")).toBe("取消聚焦");
    expect(tEn("resource.relationships.activeFocus", { number: 42 })).toBe(
      "Focusing on #42",
    );
    expect(tZh("resource.relationships.activeFocus", { number: 42 })).toBe(
      "正在聚焦 #42",
    );
  });

  test("localizes resource accessibility labels and state actions", () => {
    expect(
      tEn("resource.actions.resourceLabel", {
        kind: "PR",
        repository: "org/repo",
        number: 12,
        title: "Fix login",
      }),
    ).toBe("PR org/repo #12: Fix login");
    expect(
      tZh("resource.actions.resourceLabel", {
        kind: "PR",
        repository: "org/repo",
        number: 12,
        title: "Fix login",
      }),
    ).toBe("PR org/repo #12：Fix login");
    expect(tEn("resource.actions.expandChecks")).toBe("Expand checks");
    expect(tEn("resource.actions.collapseChecks")).toBe("Collapse checks");
    expect(tZh("resource.actions.expandChecks")).toBe("展开 Checks");
    expect(tZh("resource.actions.collapseChecks")).toBe("收起 Checks");
    expect(tEn("resource.actions.selectLabel", { label: "bug" })).toBe(
      "Filter by label bug",
    );
    expect(tZh("resource.actions.selectLabel", { label: "bug" })).toBe(
      "按标签 bug 筛选",
    );
    expect(tEn("resource.actions.selectMilestone", { milestone: "v1.0" })).toBe(
      "Filter by milestone v1.0",
    );
    expect(tZh("resource.actions.selectMilestone", { milestone: "v1.0" })).toBe(
      "按里程碑 v1.0 筛选",
    );
  });

  test("provides compact status translations in Chinese", () => {
    const translator = createTranslator("zh-CN");
    expect(translator("diagnostics.statusHealthy")).toBe("连接正常，准备就绪");
  });

  test("falls back to fallback text or key itself for unknown key", () => {
    expect(tEn("non.existent.key", undefined, "Custom Fallback")).toBe(
      "Custom Fallback",
    );
    expect(tEn("non.existent.key")).toBe("non.existent.key");
    expect(tZh("non.existent.key")).toBe("non.existent.key");
  });

  test("aligns key structures between en and zh-CN dictionaries", () => {
    function getKeys(obj: Record<string, unknown>, prefix = ""): string[] {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          keys.push(...getKeys(value as Record<string, unknown>, fullKey));
        } else {
          keys.push(fullKey);
        }
      }
      return keys.sort();
    }

    const enKeys = getKeys(en as unknown as Record<string, unknown>);
    const zhKeys = getKeys(zhCN as unknown as Record<string, unknown>);

    expect(zhKeys).toEqual(enKeys);
  });
});
